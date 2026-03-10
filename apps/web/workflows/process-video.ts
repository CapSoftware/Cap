import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import { runPromise } from "@/lib/server";

interface ProcessVideoWorkflowPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
}

interface VideoProcessingResult {
	success: boolean;
	message: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

export async function processVideoWorkflow(
	payload: ProcessVideoWorkflowPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const { videoId, userId, rawFileKey, bucketId } = payload;

	try {
		await validateProcessingRequest(videoId, rawFileKey);

		const result = await processVideoOnMediaServer(
			videoId,
			userId,
			rawFileKey,
			bucketId,
		);

		await saveMetadataAndComplete(videoId, result.metadata);
		await cleanupRawUpload(rawFileKey, bucketId);

		return {
			success: true,
			message: "Video processing completed",
			metadata: result.metadata,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setProcessingError(videoId, errorMessage);
		throw error;
	}
}

async function validateProcessingRequest(
	videoId: string,
	rawFileKey: string,
): Promise<void> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	if (!upload) {
		throw new FatalError("Upload does not exist");
	}

	if (upload.rawFileKey !== rawFileKey) {
		throw new FatalError("Upload raw file key does not match");
	}

	if (upload.phase !== "processing") {
		throw new FatalError("Upload is not ready for processing");
	}
}

interface MediaServerProcessResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

function getInputExtension(rawFileKey: string): string {
	const parts = rawFileKey.split(".");
	const extension = parts.at(-1)?.toLowerCase();

	if (!extension) {
		return ".mp4";
	}

	return `.${extension}`;
}

async function processVideoOnMediaServer(
	videoId: string,
	userId: string,
	rawFileKey: string,
	bucketId: string | null,
): Promise<MediaServerProcessResult> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId as S3Bucket.S3BucketId | null),
	).pipe(runPromise);

	const rawVideoUrl = await bucket
		.getInternalSignedObjectUrl(rawFileKey)
		.pipe(runPromise);

	const outputKey = `${userId}/${videoId}/result.mp4`;
	const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;

	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(outputKey, {
			ContentType: "video/mp4",
		})
		.pipe(runPromise);

	const thumbnailPresignedUrl = await bucket
		.getInternalPresignedPutUrl(thumbnailKey, {
			ContentType: "image/jpeg",
		})
		.pipe(runPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress`;

	const response = await fetch(`${mediaServerUrl}/video/process`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId,
			userId,
			videoUrl: rawVideoUrl,
			outputPresignedUrl,
			thumbnailPresignedUrl,
			webhookUrl,
			inputExtension: getInputExtension(rawFileKey),
		}),
	});

	if (!response.ok) {
		const errorData = await response.json().catch(() => ({}));
		throw new Error(
			(errorData as { error?: string }).error ||
				"Video processing failed to start",
		);
	}

	const { jobId } = (await response.json()) as { jobId: string };

	const result = await pollForCompletion(mediaServerUrl, jobId);

	return result;
}

async function pollForCompletion(
	mediaServerUrl: string,
	jobId: string,
): Promise<MediaServerProcessResult> {
	const maxAttempts = 360;
	const pollIntervalMs = 5000;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

		const response = await fetch(
			`${mediaServerUrl}/video/process/${jobId}/status`,
			{
				method: "GET",
				headers: { Accept: "application/json" },
			},
		);

		if (!response.ok) {
			console.warn(
				`[process-video] Failed to get job status: ${response.status}`,
			);
			continue;
		}

		const status = (await response.json()) as {
			phase: string;
			progress: number;
			error?: string;
			metadata?: {
				duration: number;
				width: number;
				height: number;
				fps: number;
			};
		};

		if (status.phase === "complete") {
			if (!status.metadata) {
				throw new Error("Processing completed but no metadata returned");
			}
			return { metadata: status.metadata };
		}

		if (status.phase === "error") {
			throw new Error(status.error || "Video processing failed");
		}

		if (status.phase === "cancelled") {
			throw new Error("Video processing was cancelled");
		}
	}

	throw new Error("Video processing timed out");
}

async function saveMetadataAndComplete(
	videoId: string,
	metadata: { duration: number; width: number; height: number; fps: number },
): Promise<void> {
	"use step";

	const duration = getValidDuration(metadata.duration);

	await db()
		.update(videos)
		.set({
			width: metadata.width,
			height: metadata.height,
			fps: metadata.fps,
			...(duration === undefined ? {} : { duration }),
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	await db()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}

async function cleanupRawUpload(
	rawFileKey: string,
	bucketId: string | null,
): Promise<void> {
	"use step";

	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId as S3Bucket.S3BucketId | null),
		).pipe(runPromise);

		await bucket.deleteObject(rawFileKey).pipe(runPromise);
	} catch (error) {
		console.error("[process-video] Failed to delete raw upload", error);
	}
}

async function setProcessingError(
	videoId: string,
	errorMessage: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: "Video processing failed",
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
