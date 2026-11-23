import type { Storage } from "@cap/web-domain";
import { Comment, type ImageUpload, type Video } from "@cap/web-domain";
import { newMediaComment } from "@/actions/videos/new-media-comment";
import { UploadRejectedError, uploadWithTarget } from "@/utils/upload-target";

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
	thumbnailUpload?: Storage.UploadTarget | null;
}

async function initiate(input: {
	videoId: string;
	kind: "video" | "audio";
	contentType: string;
	mode: "single";
	withThumbnail?: boolean;
	size: number;
	thumbnailSize?: number;
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
 * prefix, upload with one PUT signed for the blob's size, then create the
 * comment row. Returns the created comment (the shape
 * handleCommentSuccess expects).
 */
export async function uploadCommentMedia(input: CommentMediaUploadInput) {
	const isVideo = input.kind === "video";
	const init = await initiate({
		videoId: input.videoId,
		kind: input.kind,
		contentType: input.mime,
		mode: "single",
		withThumbnail: isVideo && Boolean(input.thumbnailBlob),
		size: input.blob.size,
		thumbnailSize: input.thumbnailBlob?.size,
	});

	if (!init.upload) throw new CommentMediaUploadError("failed");
	const upload = init.upload;
	// The target is signed for this exact size, so a retry re-sends the whole
	// blob. Only network failures are retried; a storage rejection is final.
	for (let attempt = 1; ; attempt++) {
		try {
			await uploadWithTarget({
				target: upload,
				body: input.blob,
				onProgress: ({ loaded, total }) => {
					if (total > 0) input.onProgress?.(Math.min(1, loaded / total));
				},
			});
			break;
		} catch (error) {
			if (error instanceof UploadRejectedError || attempt >= 3) throw error;
			await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
		}
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
