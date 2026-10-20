import { InstantRecordingUploader } from "@cap/recorder-core";
import type { Storage } from "@cap/web-domain";
import { Comment, type ImageUpload, type Video } from "@cap/web-domain";
import { newMediaComment } from "@/actions/videos/new-media-comment";
import { uploadWithTarget } from "@/utils/upload-target";

const COMMENT_MEDIA_BASE = "/api/upload/comment-media";

export class CommentMediaUploadError extends Error {
	readonly reason: "upgrade_required" | "rate_limited" | "failed";

	constructor(reason: "upgrade_required" | "rate_limited" | "failed") {
		super(`Comment media upload failed: ${reason}`);
		this.name = "CommentMediaUploadError";
		this.reason = reason;
	}
}

interface InitiateResponse {
	commentId: string;
	key: string;
	uploadToken: string;
	upload?: Storage.UploadTarget;
	uploadId?: string;
	provider?: "s3" | "googleDrive";
	thumbnailUpload?: Storage.UploadTarget | null;
}

async function initiate(input: {
	videoId: string;
	kind: "video" | "audio";
	contentType: string;
	mode: "single" | "multipart";
	withThumbnail?: boolean;
}): Promise<InitiateResponse> {
	const response = await fetch(`${COMMENT_MEDIA_BASE}/initiate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (response.status === 403)
		throw new CommentMediaUploadError("upgrade_required");
	if (response.status === 429)
		throw new CommentMediaUploadError("rate_limited");
	if (!response.ok) throw new CommentMediaUploadError("failed");
	return (await response.json()) as InitiateResponse;
}

export interface CommentMediaUploadInput {
	videoId: Video.VideoId;
	blob: Blob;
	mime: string;
	kind: "video" | "audio";
	durationSeconds: number;
	timestamp: number | null;
	/** "" sentinel for top-level, matching the web client convention. */
	parentCommentId: Comment.CommentId;
	content?: string;
	width?: number;
	height?: number;
	waveform?: number[];
	thumbnailBlob?: Blob | null;
	authorImage: ImageUpload.ImageUrl | null;
	onProgress?: (fraction: number) => void;
}

/**
 * Full pipeline for a recorded comment: presign under the parent video's
 * prefix, upload (single PUT for voice notes, multipart for video), then
 * create the comment row. Returns the created comment (the shape
 * handleCommentSuccess expects).
 */
export async function uploadCommentMedia(input: CommentMediaUploadInput) {
	const isVideo = input.kind === "video";
	const init = await initiate({
		videoId: input.videoId,
		kind: input.kind,
		contentType: input.mime,
		mode: isVideo ? "multipart" : "single",
		withThumbnail: isVideo && Boolean(input.thumbnailBlob),
	});

	if (isVideo) {
		if (!init.uploadId) throw new CommentMediaUploadError("failed");
		// Monotonic merge of two progress sources: sendProgressUpdate ticks only
		// when a whole part lands (a typical comment is ONE part — that alone
		// would jump 0→100), while chunk states carry the XHR's byte-level
		// progress inside each part. Take whichever is further along.
		let bestFraction = 0;
		const totalBytes = input.blob.size;
		const report = (fraction: number) => {
			const clamped = Math.min(1, fraction);
			if (clamped <= bestFraction) return;
			bestFraction = clamped;
			input.onProgress?.(clamped);
		};
		const uploader = new InstantRecordingUploader({
			// Only used for labels and passthrough body fields the comment routes
			// ignore; authorization travels in the token.
			videoId: input.videoId,
			uploadId: init.uploadId,
			provider: init.provider ?? "s3",
			mimeType: input.mime,
			subpath: init.key,
			setUploadStatus: () => {},
			sendProgressUpdate: async (uploaded, total) => {
				if (total > 0) report(uploaded / total);
			},
			onChunkStateChange: (chunks) => {
				if (totalBytes <= 0) return;
				const uploaded = chunks.reduce(
					(sum, chunk) => sum + chunk.uploadedBytes,
					0,
				);
				report(uploaded / totalBytes);
			},
			api: {
				multipartBasePath: COMMENT_MEDIA_BASE,
				extraBody: { uploadToken: init.uploadToken },
			},
		});
		try {
			await uploader.finalize({
				durationSeconds: input.durationSeconds,
				width: input.width,
				height: input.height,
				subpath: init.key,
				finalBlob: input.blob,
			});
		} catch (error) {
			// Incomplete multipart uploads accrue storage in the owner's bucket
			// until aborted; best-effort, the failure itself still surfaces.
			await fetch(`${COMMENT_MEDIA_BASE}/abort`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					uploadToken: init.uploadToken,
					uploadId: init.uploadId,
				}),
			}).catch(() => {});
			throw error;
		}
	} else {
		if (!init.upload) throw new CommentMediaUploadError("failed");
		await uploadWithTarget({
			target: init.upload,
			body: input.blob,
			onProgress: ({ loaded, total }) => {
				if (total > 0) input.onProgress?.(Math.min(1, loaded / total));
			},
		});
	}

	let hasThumbnail = false;
	if (isVideo && input.thumbnailBlob && init.thumbnailUpload) {
		// Non-fatal: a comment without a poster still plays.
		hasThumbnail = await uploadWithTarget({
			target: init.thumbnailUpload,
			body: input.thumbnailBlob,
		}).then(
			() => true,
			() => false,
		);
	}

	return await newMediaComment({
		videoId: input.videoId,
		commentId: Comment.CommentId.make(init.commentId),
		uploadToken: init.uploadToken,
		kind: input.kind,
		durationSeconds: input.durationSeconds,
		parentCommentId: input.parentCommentId,
		timestamp: input.timestamp,
		content: input.content,
		width: input.width,
		height: input.height,
		waveform: input.waveform,
		hasThumbnail,
		authorImage: input.authorImage,
	});
}
