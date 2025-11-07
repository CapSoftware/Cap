import type { UploadStatus } from "../../UploadingContext";
import type { VideoId } from "./web-recorder-types";

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

export const initiateMultipartUpload = async (videoId: VideoId) => {
	const result = await postJson<{ uploadId: string }>(
		"/api/upload/multipart/initiate",
		{ videoId, contentType: "video/mp4" },
	);

	if (!result.uploadId) throw new Error("Multipart initiate response missing uploadId");

	return result.uploadId;
};

const presignMultipartPart = async (
	videoId: VideoId,
	uploadId: string,
	partNumber: number,
): Promise<string> => {
	const result = await postJson<{ presignedUrl: string }>(
		"/api/upload/multipart/presign-part",
		{ videoId, uploadId, partNumber },
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
) => {
	await postJson<{ success: boolean }>("/api/upload/multipart/complete", {
		videoId,
		uploadId,
		parts,
		durationInSecs: meta.durationSeconds,
		width: meta.width,
		height: meta.height,
		fps: meta.fps,
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
	private readonly setUploadStatus: SetUploadStatus;
	private readonly sendProgressUpdate: ProgressUpdater;

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

	constructor(options: {
		videoId: VideoId;
		uploadId: string;
		mimeType: string;
		setUploadStatus: SetUploadStatus;
		sendProgressUpdate: ProgressUpdater;
	}) {
		this.videoId = options.videoId;
		this.uploadId = options.uploadId;
		this.mimeType = options.mimeType;
		this.setUploadStatus = options.setUploadStatus;
		this.sendProgressUpdate = options.sendProgressUpdate;
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
		this.uploadPromise = this.uploadPromise
			.then(() => this.uploadPart(part))
			.catch((error) => {
				throw error;
			});
	}

	private async uploadPart(part: Blob) {
		const partNumber = this.nextPartNumber++;
		const presignedUrl = await presignMultipartPart(
			this.videoId,
			this.uploadId,
			partNumber,
		);

		const response = await fetch(presignedUrl, {
			method: "PUT",
			body: part,
			headers: {
				"Content-Type": this.mimeType,
				"Content-Length": `${part.size}`,
			},
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Failed to upload part ${partNumber}: ${response.status} ${errorBody}`,
			);
		}

		const etagHeader = response.headers.get("ETag");
		const etag = etagHeader?.replace(/"/g, "");
		if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);

		this.parts.push({ partNumber, etag, size: part.size });
		this.uploadedBytes += part.size;
		this.emitProgress();
	}

	private emitProgress() {
		const totalBytes = this.finalTotalBytes ?? Math.max(this.totalRecordedBytes, this.uploadedBytes);
		const progress = totalBytes > 0 ? Math.min(100, (this.uploadedBytes / totalBytes) * 100) : 0;

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
		);

		this.finished = true;
		this.uploadedBytes = this.finalTotalBytes ?? this.uploadedBytes;
		this.setUploadStatus({
			status: "uploadingVideo",
			capId: this.videoId,
			progress: 100,
			thumbnailUrl: this.thumbnailUrl,
		});
		await this.sendProgressUpdate(
			this.uploadedBytes,
			this.uploadedBytes,
		);
	}

	async cancel() {
		if (this.finished) return;
		this.bufferedChunks = [];
		this.bufferedBytes = 0;
		try {
			await this.uploadPromise;
		} catch {
			// Swallow errors during cancellation cleanup.
		}
	}
}
