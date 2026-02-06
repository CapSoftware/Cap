import type { UploadStatus } from "../../UploadingContext";
import type { ChunkUploadState, VideoId } from "./web-recorder-types";

const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

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
		throw new Error(`Request to ${url} failed: ${response.status} ${message}`);
	}

	return (await response.json()) as TResponse;
};

export const initiateMultipartUpload = async (
	videoId: VideoId,
	subpath?: string,
) => {
	const result = await postJson<{ uploadId: string }>(
		"/api/upload/multipart/initiate",
		{ videoId, contentType: "video/mp4", subpath },
	);

	if (!result.uploadId)
		throw new Error("Multipart initiate response missing uploadId");

	return result.uploadId;
};

const presignMultipartPart = async (
	videoId: VideoId,
	uploadId: string,
	partNumber: number,
	subpath?: string,
): Promise<string> => {
	const result = await postJson<{ presignedUrl: string }>(
		"/api/upload/multipart/presign-part",
		{ videoId, uploadId, partNumber, subpath },
	);

	if (!result.presignedUrl) {
		throw new Error(`Missing presigned URL for part ${partNumber}`);
	}

	return result.presignedUrl;
};

const completeMultipartUpload = async (
	videoId: VideoId,
	uploadId: string,
	parts: UploadedPartPayload[],
	meta: MultipartCompletePayload,
	subpath?: string,
) => {
	await postJson<{ success: boolean }>("/api/upload/multipart/complete", {
		videoId,
		uploadId,
		parts,
		durationInSecs: meta.durationSeconds,
		width: meta.width,
		height: meta.height,
		fps: meta.fps,
		subpath,
	});
};

const abortMultipartUpload = async (
	videoId: VideoId,
	uploadId: string,
	subpath?: string,
) => {
	await postJson<{ success: boolean }>("/api/upload/multipart/abort", {
		videoId,
		uploadId,
		subpath,
	});
};

interface FinalizeOptions extends MultipartCompletePayload {
	finalBlob: Blob;
	thumbnailUrl?: string;
}

export class InstantMp4Uploader {
	private readonly videoId: VideoId;
	private readonly uploadId: string;
	private readonly mimeType: string;
	private readonly subpath: string | undefined;
	private readonly setUploadStatus: SetUploadStatus;
	private readonly sendProgressUpdate: ProgressUpdater;
	private readonly onChunkStateChange?: (chunks: ChunkUploadState[]) => void;

	private bufferedChunks: Blob[] = [];
	private bufferedBytes = 0;
	private totalRecordedBytes = 0;
	private uploadedBytes = 0;
	private uploadPromise: Promise<void> = Promise.resolve();
	private readonly parts: UploadedPartPayload[] = [];
	private nextPartNumber = 1;
	private finished = false;
	private finalTotalBytes: number | null = null;
	private thumbnailUrl: string | undefined;
	private readonly chunkStates = new Map<number, ChunkUploadState>();

	constructor(options: {
		videoId: VideoId;
		uploadId: string;
		mimeType: string;
		subpath?: string;
		setUploadStatus: SetUploadStatus;
		sendProgressUpdate: ProgressUpdater;
		onChunkStateChange?: (chunks: ChunkUploadState[]) => void;
	}) {
		this.videoId = options.videoId;
		this.uploadId = options.uploadId;
		this.mimeType = options.mimeType;
		this.subpath = options.subpath;
		this.setUploadStatus = options.setUploadStatus;
		this.sendProgressUpdate = options.sendProgressUpdate;
		this.onChunkStateChange = options.onChunkStateChange;
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

	setThumbnailUrl(previewUrl: string | undefined) {
		this.thumbnailUrl = previewUrl;
	}

	handleChunk(blob: Blob, recordedTotalBytes: number) {
		if (this.finished || blob.size === 0) return;

		this.totalRecordedBytes = recordedTotalBytes;
		this.bufferedChunks.push(blob);
		this.bufferedBytes += blob.size;

		if (this.bufferedBytes >= MIN_PART_SIZE_BYTES) {
			this.flushBuffer();
		}
	}

	private flushBuffer(force = false) {
		if (this.bufferedBytes === 0) return;
		if (!force && this.bufferedBytes < MIN_PART_SIZE_BYTES) return;

		const chunk = new Blob(this.bufferedChunks, { type: this.mimeType });
		this.bufferedChunks = [];
		this.bufferedBytes = 0;

		this.enqueueUpload(chunk);
	}

	private enqueueUpload(part: Blob) {
		const partNumber = this.nextPartNumber++;
		this.registerChunk(partNumber, part.size);
		this.uploadPromise = this.uploadPromise
			.then(() => this.uploadPart(partNumber, part))
			.catch((error) => {
				this.updateChunkState(partNumber, { status: "error" });
				throw error;
			});
	}

	private async uploadPart(partNumber: number, part: Blob) {
		const presignedUrl = await presignMultipartPart(
			this.videoId,
			this.uploadId,
			partNumber,
			this.subpath,
		);

		const etag = await this.uploadBlobWithProgress({
			url: presignedUrl,
			partNumber,
			part,
		});

		this.parts.push({ partNumber, etag, size: part.size });
		this.uploadedBytes += part.size;
		this.emitProgress();
	}

	private uploadBlobWithProgress({
		url,
		partNumber,
		part,
	}: {
		url: string;
		partNumber: number;
		part: Blob;
	}): Promise<string> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("PUT", url);
			xhr.responseType = "text";
			if (this.mimeType) {
				xhr.setRequestHeader("Content-Type", this.mimeType);
			}

			this.updateChunkState(partNumber, {
				status: "uploading",
				uploadedBytes: 0,
				progress: 0,
			});

			xhr.upload.onprogress = (event) => {
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
				if (xhr.status >= 200 && xhr.status < 300) {
					const etagHeader = xhr.getResponseHeader("ETag");
					const etag = etagHeader?.replace(/"/g, "");
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
				this.updateChunkState(partNumber, { status: "error" });
				reject(new Error(`Failed to upload part ${partNumber}: network error`));
			};

			xhr.send(part);
		});
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
			thumbnailUrl: this.thumbnailUrl,
		});

		void this.sendProgressUpdate(this.uploadedBytes, totalBytes).catch(
			(error) => {
				console.error("Failed to send upload progress", error);
			},
		);
	}

	async finalize(options: FinalizeOptions) {
		if (this.finished) return;

		this.finalTotalBytes = options.finalBlob.size;
		this.thumbnailUrl = options.thumbnailUrl;
		this.flushBuffer(true);

		await this.uploadPromise;

		if (this.parts.length === 0) {
			this.enqueueUpload(options.finalBlob);
			await this.uploadPromise;
		}

		await completeMultipartUpload(
			this.videoId,
			this.uploadId,
			this.parts,
			{
				durationSeconds: options.durationSeconds,
				width: options.width,
				height: options.height,
				fps: options.fps,
			},
			this.subpath,
		);

		this.finished = true;
		this.uploadedBytes = this.finalTotalBytes ?? this.uploadedBytes;
		this.setUploadStatus({
			status: "uploadingVideo",
			capId: this.videoId,
			progress: 100,
			thumbnailUrl: this.thumbnailUrl,
		});
		await this.sendProgressUpdate(this.uploadedBytes, this.uploadedBytes);
	}

	async cancel() {
		if (this.finished) return;
		this.finished = true;
		this.bufferedChunks = [];
		this.bufferedBytes = 0;
		this.clearChunkStates();
		const pendingUpload = this.uploadPromise.catch(() => {
			// Swallow errors during cancellation cleanup.
		});
		try {
			await abortMultipartUpload(this.videoId, this.uploadId, this.subpath);
		} catch (error) {
			console.error("Failed to abort multipart upload", error);
		}
		await pendingUpload;
	}
}
