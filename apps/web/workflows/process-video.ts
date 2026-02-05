import { db } from "@cap/database";
import { s3Buckets, videos, videoUploads } from "@cap/database/schema";
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

export async function processVideoWorkflow(
	payload: ProcessVideoWorkflowPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const { videoId, userId, rawFileKey, bucketId } = payload;

	await validateAndSetProcessing(videoId, rawFileKey);

	const result = await processVideoOnMediaServer(
		videoId,
		userId,
		rawFileKey,
		bucketId,
	);

	await saveMetadataAndComplete(videoId, result.metadata);

	return {
		success: true,
		message: "Video processing completed",
		metadata: result.metadata,
	};
}

async function validateAndSetProcessing(
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

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video processing...",
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}

interface MediaServerProcessResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

async function readMediaServerErrorMessage(
	response: Response,
	fallbackMessage: string,
): Promise<string> {
	const statusLabel = `status ${response.status}${
		response.statusText ? ` ${response.statusText}` : ""
	}`;
	const responseText = await response.text().catch(() => "");

	if (responseText) {
		try {
			const parsed = JSON.parse(responseText) as {
				error?: unknown;
				details?: unknown;
				code?: unknown;
			};
			const error =
				typeof parsed.error === "string" ? parsed.error.trim() : undefined;
			const details =
				typeof parsed.details === "string" ? parsed.details.trim() : undefined;
			const code =
				typeof parsed.code === "string" ? parsed.code.trim() : undefined;

			if (error && details && code) {
				return `${fallbackMessage} (${statusLabel}, code ${code}): ${error} (${details})`;
			}

			if (error && details) {
				return `${fallbackMessage} (${statusLabel}): ${error} (${details})`;
			}

			if (error && code) {
				return `${fallbackMessage} (${statusLabel}, code ${code}): ${error}`;
			}

			if (error) {
				return `${fallbackMessage} (${statusLabel}): ${error}`;
			}
		} catch {}

		return `${fallbackMessage} (${statusLabel}): ${responseText.slice(0, 500)}`;
	}

	return `${fallbackMessage} (${statusLabel})`;
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
		}),
	});

	if (!response.ok) {
		throw new Error(
			await readMediaServerErrorMessage(
				response,
				"Video processing failed to start",
			),
		);
	}

	const { jobId } = (await response.json()) as { jobId: string };

	const result = await pollForCompletion(mediaServerUrl!, jobId, videoId);

	return result;
}

async function pollForCompletion(
	mediaServerUrl: string,
	jobId: string,
	videoId: string,
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

	await db()
		.update(videos)
		.set({
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	await db()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
