import type { UploadStatus } from "../../UploadingContext";
import type { ChunkUploadState, VideoId } from "./web-recorder-types";

const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PART_UPLOAD_ATTEMPTS = 3;
const MAX_PARALLEL_PART_UPLOADS = 3;
const MAX_PENDING_UPLOAD_BYTES = 128 * 1024 * 1024;
const FINAL_BLOB_PART_SIZE_BYTES = 16 * 1024 * 1024;
const DRIVE_PART_SIZE_BYTES = 16 * 1024 * 1024;
const PART_UPLOAD_STALL_TIMEOUT_MS = 30_000;
const PART_UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

type SetUploadStatus = (status: UploadStatus | undefined) => void;

type ProgressUpdater = (uploaded: number, total: number) => Promise<void>;

interface UploadedPartPayload {
	partNumber: number;
	etag: string;
	size: number;
}

interface MultipartCompletePayload {
	durationSeconds: number;
	width?: number;
	height?: number;
	fps?: number;
	subpath: string;
}

class HttpRequestError extends Error {
	readonly status: number;
	readonly url: string;

	constructor(url: string, status: number, message: string) {
		super(`Request to ${url} failed: ${status} ${message}`);
		this.name = "HttpRequestError";
		this.status = status;
		this.url = url;
	}
}

export class ProcessingStartError extends Error {
	constructor() {
		super("Video uploaded, but processing could not start");
		this.name = "ProcessingStartError";
	}
}

export class MultipartCompletionUncertainError extends Error {
	constructor(cause?: unknown) {
		super("Multipart upload completed but confirmation was interrupted", {
			cause,
		});
		this.name = "MultipartCompletionUncertainError";
	}
}

class CancelledUploadError extends Error {
	constructor() {
		super("Multipart upload was cancelled");
		this.name = "CancelledUploadError";
	}
}

const postJson = async <TResponse>(
	url: string,
	body: Record<string, unknown>,
): Promise<TResponse> => {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const message = await response.text();
		throw new HttpRequestError(url, response.status, message);
	}

	return (await response.json()) as TResponse;
};

const normalizeMultipartContentType = (mimeType: string) => {
	const normalized = mimeType.split(";")[0]?.trim();
	return normalized || "application/octet-stream";
};

export const initiateMultipartUpload = async ({
	videoId,
	contentType,
	subpath,
}: {
	videoId: VideoId;
	contentType: string;
	subpath: string;
}) => {
	const result = await postJson<{
		uploadId: string;
		provider?: "s3" | "googleDrive";
	}>("/api/upload/multipart/initiate", {
		videoId,
		contentType: normalizeMultipartContentType(contentType),
		subpath,
	});

	if (!result.uploadId) {
		throw new Error("Multipart initiate response missing uploadId");
	}

	return {
		uploadId: result.uploadId,
		provider: result.provider ?? "s3",
	};
};

const presignMultipartPart = async (
	videoId: VideoId,
	uploadId: string,
	partNumber: number,
	subpath: string,
): Promise<{ url: string; provider: "s3" | "googleDrive" }> => {
	const result = await postJson<{
		presignedUrl: string;
		provider?: "s3" | "googleDrive";
	}>("/api/upload/multipart/presign-part", {
		videoId,
		uploadId,
		partNumber,
		subpath,
	});

	if (!result.presignedUrl) {
		throw new Error(`Missing presigned URL for part ${partNumber}`);
	}

	return {
		url: result.presignedUrl,
		provider: result.provider ?? "s3",
	};
};

const completeMultipartUpload = async (
	videoId: VideoId,
	uploadId: string,
	parts: UploadedPartPayload[],
	meta: MultipartCompletePayload,
): Promise<{ processingStarted: boolean }> => {
	try {
		const response = await postJson<{
			success: boolean;
			processingStarted?: boolean;
		}>("/api/upload/multipart/complete", {
			videoId,
			uploadId,
			parts,
			subpath: meta.subpath,
			durationInSecs: meta.durationSeconds,
			width: meta.width,
			height: meta.height,
			fps: meta.fps,
		});

		return {
			processingStarted: response.processingStarted !== false,
		};
	} catch (error) {
		if (error instanceof HttpRequestError && error.status < 500) {
			throw error;
		}

		throw new MultipartCompletionUncertainError(error);
	}
};

const abortMultipartUpload = async (
	videoId: VideoId,
	uploadId: string,
	subpath: string,
) => {
	await postJson<{ success: boolean }>("/api/upload/multipart/abort", {
		videoId,
		uploadId,
		subpath,
	});
};

interface FinalizeOptions extends MultipartCompletePayload {
	finalBlob?: Blob | null;
}

export class InstantRecordingUploader {
	private readonly videoId: VideoId;
	private readonly uploadId: string;
	private readonly provider: "s3" | "googleDrive";
	private readonly mimeType: string;
	private readonly subpath: string;
	private readonly setUploadStatus: SetUploadStatus;
	private readonly sendProgressUpdate: ProgressUpdater;
	private readonly onChunkStateChange?: (chunks: ChunkUploadState[]) => void;
	private readonly onOverflow?: (error: Error) => void;
	private readonly onFatalError?: (error: Error) => void;

	private bufferedChunks: Blob[] = [];
	private bufferedBytes = 0;
	private totalRecordedBytes = 0;
	private uploadedBytes = 0;
	private pendingUploadBytes = 0;
	private readonly pendingUploadTasks = new Set<Promise<void>>();
	private availableUploadSlots: number;
	private readonly uploadSlotWaiters: Array<() => void> = [];
	private readonly parts: UploadedPartPayload[] = [];
	private nextPartNumber = 1;
	private finished = false;
	private cancelled = false;
	private fatalError: Error | null = null;
	private finalTotalBytes: number | null = null;
	private readonly chunkStates = new Map<number, ChunkUploadState>();
	private readonly activeRequests = new Map<number, XMLHttpRequest>();
	private readonly retryTimeouts = new Set<number>();
	private readonly retryWaiters = new Set<
		(error: CancelledUploadError) => void
	>();
	private readonly stallTimeouts = new Set<number>();
	private processingStarted = true;
	private queuedBytes = 0;
	private readonly partOffsets = new Map<number, number>();

	constructor(options: {
		videoId: VideoId;
		uploadId: string;
		provider?: "s3" | "googleDrive";
		mimeType: string;
		subpath: string;
		setUploadStatus: SetUploadStatus;
		sendProgressUpdate: ProgressUpdater;
		onChunkStateChange?: (chunks: ChunkUploadState[]) => void;
		onOverflow?: (error: Error) => void;
		onFatalError?: (error: Error) => void;
	}) {
		this.videoId = options.videoId;
		this.uploadId = options.uploadId;
		this.provider = options.provider ?? "s3";
		this.mimeType = options.mimeType;
		this.subpath = options.subpath;
		this.setUploadStatus = options.setUploadStatus;
		this.sendProgressUpdate = options.sendProgressUpdate;
		this.onChunkStateChange = options.onChunkStateChange;
		this.onOverflow = options.onOverflow;
		this.onFatalError = options.onFatalError;
		this.availableUploadSlots =
			this.provider === "googleDrive" ? 1 : MAX_PARALLEL_PART_UPLOADS;
	}

	private markFatalError(error: Error) {
		if (this.fatalError) {
			return this.fatalError;
		}

		this.fatalError = error;
		this.onFatalError?.(error);
		return error;
	}

	private emitChunkSnapshot() {
		if (!this.onChunkStateChange) return;
		const ordered = Array.from(this.chunkStates.values()).sort(
			(a, b) => a.partNumber - b.partNumber,
		);
		this.onChunkStateChange(ordered);
	}

	private updateChunkState(
		partNumber: number,
		updates: Partial<ChunkUploadState>,
	) {
		const current = this.chunkStates.get(partNumber);
		if (!current) return;

		const next: ChunkUploadState = {
			...current,
			...updates,
		};

		if (updates.uploadedBytes !== undefined) {
			next.uploadedBytes = Math.max(
				0,
				Math.min(current.sizeBytes, updates.uploadedBytes),
			);
		}

		if (updates.progress !== undefined) {
			next.progress = Math.min(1, Math.max(0, updates.progress));
		} else if (updates.uploadedBytes !== undefined) {
			const denominator = current.sizeBytes || 1;
			next.progress = Math.min(
				1,
				Math.max(0, next.uploadedBytes / denominator),
			);
		}

		this.chunkStates.set(partNumber, next);
		this.emitChunkSnapshot();
	}

	private registerChunk(partNumber: number, sizeBytes: number) {
		this.chunkStates.set(partNumber, {
			partNumber,
			sizeBytes,
			uploadedBytes: 0,
			progress: 0,
			status: "queued",
		});
		this.emitChunkSnapshot();
	}

	private clearChunkStates() {
		this.chunkStates.clear();
		this.emitChunkSnapshot();
	}

	private emitProgress() {
		const totalBytes =
			this.finalTotalBytes ??
			Math.max(this.totalRecordedBytes, this.uploadedBytes);
		const progress =
			totalBytes > 0
				? Math.min(100, (this.uploadedBytes / totalBytes) * 100)
				: 0;

		this.setUploadStatus({
			status: "uploadingVideo",
			capId: this.videoId,
			progress,
			thumbnailUrl: undefined,
		});

		void this.sendProgressUpdate(this.uploadedBytes, totalBytes).catch(
			(error) => {
				console.error("Failed to send upload progress", error);
			},
		);
	}

	handleChunk(blob: Blob, recordedTotalBytes: number) {
		if (this.finished || blob.size === 0) return;
		if (this.fatalError) {
			throw this.fatalError;
		}

		this.totalRecordedBytes = recordedTotalBytes;
		this.bufferedChunks.push(blob);
		this.bufferedBytes += blob.size;

		if (this.bufferedBytes >= MIN_PART_SIZE_BYTES) {
			this.flushBuffer();
		}
	}

	private flushBuffer(force = false) {
		if (this.provider === "googleDrive") {
			this.flushDriveBuffer(force);
			return;
		}

		if (this.bufferedBytes === 0) return;
		if (!force && this.bufferedBytes < MIN_PART_SIZE_BYTES) return;

		const chunk = new Blob(this.bufferedChunks, { type: this.mimeType });
		this.bufferedChunks = [];
		this.bufferedBytes = 0;

		this.enqueueUpload(chunk);
	}

	private flushDriveBuffer(force = false) {
		while (this.bufferedBytes > 0) {
			if (!force && this.bufferedBytes < DRIVE_PART_SIZE_BYTES) return;

			const partSize =
				force && this.bufferedBytes <= DRIVE_PART_SIZE_BYTES
					? this.bufferedBytes
					: DRIVE_PART_SIZE_BYTES;
			const { part, remainingChunks, remainingBytes } =
				this.takeBufferedPart(partSize);

			this.bufferedChunks = remainingChunks;
			this.bufferedBytes = remainingBytes;
			this.enqueueUpload(part);

			if (partSize < DRIVE_PART_SIZE_BYTES) return;
		}
	}

	private takeBufferedPart(size: number) {
		const partChunks: Blob[] = [];
		const remainingChunks: Blob[] = [];
		let remainingPartBytes = size;
		let consumedBuffer = true;

		for (const chunk of this.bufferedChunks) {
			if (!consumedBuffer) {
				remainingChunks.push(chunk);
				continue;
			}

			if (chunk.size <= remainingPartBytes) {
				partChunks.push(chunk);
				remainingPartBytes -= chunk.size;
				if (remainingPartBytes === 0) consumedBuffer = false;
				continue;
			}

			partChunks.push(chunk.slice(0, remainingPartBytes, this.mimeType));
			remainingChunks.push(
				chunk.slice(remainingPartBytes, chunk.size, this.mimeType),
			);
			consumedBuffer = false;
			remainingPartBytes = 0;
		}

		return {
			part: new Blob(partChunks, { type: this.mimeType }),
			remainingChunks,
			remainingBytes: this.bufferedBytes - size,
		};
	}

	private createFinalBlobPart(finalBlob: Blob, start: number, end: number) {
		return finalBlob.slice(start, end, this.mimeType);
	}

	private resolveFinalTotalBytes(finalBlob?: Blob | null) {
		return (
			finalBlob?.size ??
			Math.max(this.totalRecordedBytes, this.queuedBytes + this.bufferedBytes)
		);
	}

	private enqueueUpload(part: Blob) {
		if (this.pendingUploadBytes + part.size > MAX_PENDING_UPLOAD_BYTES) {
			const error = this.markFatalError(
				new Error("Upload could not keep up with recording"),
			);
			this.onOverflow?.(error);
			throw error;
		}

		const partNumber = this.nextPartNumber++;
		this.partOffsets.set(partNumber, this.queuedBytes);
		this.queuedBytes += part.size;
		this.pendingUploadBytes += part.size;
		this.registerChunk(partNumber, part.size);
		const uploadTask = this.runPartUpload(partNumber, part);
		this.pendingUploadTasks.add(uploadTask);
		void uploadTask.catch(() => {});
		void uploadTask.then(
			() => {
				this.pendingUploadTasks.delete(uploadTask);
			},
			() => {
				this.pendingUploadTasks.delete(uploadTask);
			},
		);
	}

	private async uploadFinalBlob(finalBlob: Blob) {
		let offset = 0;

		while (offset < finalBlob.size) {
			const partSize = Math.min(
				FINAL_BLOB_PART_SIZE_BYTES,
				finalBlob.size - offset,
			);

			if (this.pendingUploadBytes + partSize > MAX_PENDING_UPLOAD_BYTES) {
				await this.waitForPendingUploads();
				continue;
			}

			const end = offset + partSize;
			this.enqueueUpload(this.createFinalBlobPart(finalBlob, offset, end));
			offset = end;
		}

		await this.waitForPendingUploads();
	}

	private async runPartUpload(partNumber: number, part: Blob) {
		await this.acquireUploadSlot();
		try {
			if (this.cancelled) {
				throw new CancelledUploadError();
			}
			await this.uploadPartWithRetry(partNumber, part);
		} finally {
			this.releaseUploadSlot();
		}
	}

	private async acquireUploadSlot() {
		if (this.availableUploadSlots > 0) {
			this.availableUploadSlots -= 1;
			return;
		}

		await new Promise<void>((resolve) => {
			this.uploadSlotWaiters.push(resolve);
		});
	}

	private releaseUploadSlot() {
		const nextWaiter = this.uploadSlotWaiters.shift();
		if (nextWaiter) {
			nextWaiter();
			return;
		}

		this.availableUploadSlots = Math.min(
			this.provider === "googleDrive" ? 1 : MAX_PARALLEL_PART_UPLOADS,
			this.availableUploadSlots + 1,
		);
	}

	private async waitForPendingUploads() {
		while (this.pendingUploadTasks.size > 0) {
			const results = await Promise.allSettled(
				Array.from(this.pendingUploadTasks),
			);
			const rejection = results.find((result) => result.status === "rejected");
			if (rejection?.status === "rejected") {
				throw rejection.reason;
			}
		}
	}

	private async uploadPartWithRetry(partNumber: number, part: Blob) {
		let attempt = 0;

		while (attempt < MAX_PART_UPLOAD_ATTEMPTS) {
			if (this.cancelled) {
				throw new CancelledUploadError();
			}

			attempt += 1;
			try {
				await this.uploadPart(partNumber, part);
				return;
			} catch (error) {
				if (error instanceof CancelledUploadError || this.cancelled) {
					throw new CancelledUploadError();
				}

				if (attempt >= MAX_PART_UPLOAD_ATTEMPTS) {
					this.updateChunkState(partNumber, { status: "error" });
					this.pendingUploadBytes = Math.max(
						0,
						this.pendingUploadBytes - part.size,
					);
					throw this.markFatalError(
						error instanceof Error ? error : new Error(String(error)),
					);
				}

				this.updateChunkState(partNumber, {
					status: "queued",
					uploadedBytes: 0,
					progress: 0,
				});
				await this.waitForRetryDelay(attempt * 500);
			}
		}
	}

	private waitForRetryDelay(delayMs: number) {
		if (this.cancelled) {
			return Promise.reject(new CancelledUploadError());
		}

		return new Promise<void>((resolve, reject) => {
			const cancelWaiter = (error: CancelledUploadError) => {
				window.clearTimeout(timeoutId);
				this.retryTimeouts.delete(timeoutId);
				this.retryWaiters.delete(cancelWaiter);
				reject(error);
			};
			const timeoutId = window.setTimeout(() => {
				this.retryTimeouts.delete(timeoutId);
				this.retryWaiters.delete(cancelWaiter);
				resolve();
			}, delayMs);
			this.retryTimeouts.add(timeoutId);
			this.retryWaiters.add(cancelWaiter);
		});
	}

	private clearRetryTimeouts() {
		this.retryTimeouts.forEach((timeoutId) => {
			window.clearTimeout(timeoutId);
		});
		this.retryTimeouts.clear();
	}

	private cancelPendingRetryWaiters() {
		const waiters = Array.from(this.retryWaiters);
		this.retryWaiters.clear();
		const error = new CancelledUploadError();
		for (const waiter of waiters) {
			waiter(error);
		}
	}

	private clearStallTimeouts() {
		this.stallTimeouts.forEach((timeoutId) => {
			window.clearTimeout(timeoutId);
		});
		this.stallTimeouts.clear();
	}

	private abortActiveRequests() {
		const activeRequests = Array.from(this.activeRequests.values());
		this.activeRequests.clear();
		for (const request of activeRequests) {
			request.abort();
		}
	}

	private async uploadPart(partNumber: number, part: Blob) {
		const upload = await presignMultipartPart(
			this.videoId,
			this.uploadId,
			partNumber,
			this.subpath,
		);

		const etag = await this.uploadBlobWithProgress({
			url: upload.url,
			provider: upload.provider,
			partNumber,
			part,
		});

		this.parts.push({ partNumber, etag, size: part.size });
		this.pendingUploadBytes = Math.max(0, this.pendingUploadBytes - part.size);
		this.uploadedBytes += part.size;
		this.emitProgress();
	}

	private uploadBlobWithProgress({
		url,
		provider,
		partNumber,
		part,
	}: {
		url: string;
		provider: "s3" | "googleDrive";
		partNumber: number;
		part: Blob;
	}): Promise<string> {
		return new Promise((resolve, reject) => {
			if (this.cancelled) {
				reject(new CancelledUploadError());
				return;
			}

			const xhr = new XMLHttpRequest();
			xhr.open("PUT", url);
			xhr.responseType = "text";
			xhr.timeout = PART_UPLOAD_REQUEST_TIMEOUT_MS;
			let isFinalDrivePart = false;
			if (provider === "googleDrive") {
				const start = this.partOffsets.get(partNumber) ?? 0;
				const end = start + part.size - 1;
				isFinalDrivePart =
					this.finalTotalBytes !== null && end + 1 >= this.finalTotalBytes;
				const total =
					isFinalDrivePart && this.finalTotalBytes !== null
						? this.finalTotalBytes.toString()
						: "*";
				xhr.setRequestHeader("Content-Range", `bytes ${start}-${end}/${total}`);
				xhr.setRequestHeader("Content-Type", this.mimeType);
			}
			this.activeRequests.set(partNumber, xhr);

			this.updateChunkState(partNumber, {
				status: "uploading",
				uploadedBytes: 0,
				progress: 0,
			});

			const clearRequest = () => {
				this.activeRequests.delete(partNumber);
			};
			let stallTimeoutId: number | null = null;
			const clearStallTimeout = () => {
				if (stallTimeoutId === null) {
					return;
				}
				window.clearTimeout(stallTimeoutId);
				this.stallTimeouts.delete(stallTimeoutId);
				stallTimeoutId = null;
			};
			const refreshStallTimeout = () => {
				clearStallTimeout();
				const timeoutId = window.setTimeout(() => {
					this.stallTimeouts.delete(timeoutId);
					stallTimeoutId = null;
					xhr.abort();
				}, PART_UPLOAD_STALL_TIMEOUT_MS);
				stallTimeoutId = timeoutId;
				this.stallTimeouts.add(timeoutId);
			};
			refreshStallTimeout();

			xhr.upload.onprogress = (event) => {
				refreshStallTimeout();
				const uploaded = event.lengthComputable
					? event.loaded
					: Math.min(part.size, event.loaded);
				const total = event.lengthComputable ? event.total : part.size;
				const ratio = total > 0 ? Math.min(1, uploaded / total) : 0;
				this.updateChunkState(partNumber, {
					status: "uploading",
					uploadedBytes: uploaded,
					progress: ratio,
				});
			};

			xhr.onload = () => {
				clearStallTimeout();
				clearRequest();
				if (
					(xhr.status >= 200 && xhr.status < 300) ||
					(provider === "googleDrive" &&
						xhr.status === 308 &&
						!isFinalDrivePart)
				) {
					const etagHeader = xhr.getResponseHeader("ETag");
					const etag =
						etagHeader?.replace(/"/g, "") ||
						(provider === "googleDrive" ? `drive-${partNumber}` : "");
					if (!etag) {
						this.updateChunkState(partNumber, { status: "error" });
						reject(new Error(`Missing ETag for part ${partNumber}`));
						return;
					}
					this.updateChunkState(partNumber, {
						status: "complete",
						uploadedBytes: part.size,
						progress: 1,
					});
					resolve(etag);
					return;
				}

				this.updateChunkState(partNumber, { status: "error" });
				reject(
					new Error(
						`Failed to upload part ${partNumber}: ${xhr.status} ${xhr.statusText}`,
					),
				);
			};

			xhr.onerror = () => {
				clearStallTimeout();
				clearRequest();
				this.updateChunkState(partNumber, { status: "error" });
				reject(new Error(`Failed to upload part ${partNumber}: network error`));
			};

			xhr.ontimeout = () => {
				clearStallTimeout();
				clearRequest();
				this.updateChunkState(partNumber, { status: "error" });
				reject(new Error(`Failed to upload part ${partNumber}: timed out`));
			};

			xhr.onabort = () => {
				clearStallTimeout();
				clearRequest();
				reject(
					this.cancelled
						? new CancelledUploadError()
						: new Error(`Failed to upload part ${partNumber}: stalled`),
				);
			};

			xhr.send(part);
		});
	}

	async finalize(options: FinalizeOptions) {
		if (this.finished) return;
		if (this.fatalError) {
			throw this.fatalError;
		}

		const finalTotalBytes = this.resolveFinalTotalBytes(options.finalBlob);

		if (this.provider === "googleDrive") {
			if (finalTotalBytes <= 0) {
				throw new Error(
					"Cannot finalize Google Drive upload without a byte count",
				);
			}
			this.finalTotalBytes = finalTotalBytes;
			this.totalRecordedBytes = finalTotalBytes;
		} else if (options.finalBlob) {
			this.finalTotalBytes = options.finalBlob.size;
			this.totalRecordedBytes = options.finalBlob.size;
		}

		this.flushBuffer(true);
		await this.waitForPendingUploads();

		if (options.finalBlob && this.parts.length === 0) {
			await this.uploadFinalBlob(options.finalBlob);
		}

		if (this.parts.length === 0) {
			throw new Error("No uploaded parts available for completion");
		}

		const completionResult = await completeMultipartUpload(
			this.videoId,
			this.uploadId,
			[...this.parts].sort((left, right) => left.partNumber - right.partNumber),
			{
				durationSeconds: options.durationSeconds,
				width: options.width,
				height: options.height,
				fps: options.fps,
				subpath: options.subpath,
			},
		);
		this.processingStarted = completionResult.processingStarted;

		this.finished = true;
		this.uploadedBytes = this.finalTotalBytes ?? this.uploadedBytes;
		this.setUploadStatus({
			status: "uploadingVideo",
			capId: this.videoId,
			progress: 100,
			thumbnailUrl: undefined,
		});
		await this.sendProgressUpdate(this.uploadedBytes, this.uploadedBytes);
	}

	getProcessingStarted() {
		return this.processingStarted;
	}

	async cancel() {
		if (this.finished) return;
		this.cancelled = true;
		this.finished = true;
		this.bufferedChunks = [];
		this.bufferedBytes = 0;
		this.clearRetryTimeouts();
		this.cancelPendingRetryWaiters();
		this.clearStallTimeouts();
		this.abortActiveRequests();
		this.clearChunkStates();
		const pendingUpload = this.waitForPendingUploads().catch(() => {});
		try {
			await abortMultipartUpload(this.videoId, this.uploadId, this.subpath);
		} catch (error) {
			console.error("Failed to abort multipart upload", error);
		}
		await pendingUpload;
	}
}
