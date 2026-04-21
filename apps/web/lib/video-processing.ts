import { db } from "@cap/database";
import { videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { and, eq, ne } from "drizzle-orm";
import { Option } from "effect";
import { runPromise } from "@/lib/server";

export type VideoProcessingStartStatus = "started" | "already-processing";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function setVideoProcessingError(
	videoId: Video.VideoId,
	processingMessage: string,
	error: unknown,
): Promise<void> {
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage,
			processingError: error instanceof Error ? error.message : String(error),
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId));
}

export async function transitionVideoToProcessing({
	videoId,
	rawFileKey,
	processingMessage,
	mode,
	forceRestart,
}: {
	videoId: Video.VideoId;
	rawFileKey: string;
	processingMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
}): Promise<VideoProcessingStartStatus> {
	const result = await db()
		.update(videoUploads)
		.set({
			...(mode ? { mode } : {}),
			phase: "processing",
			processingProgress: 0,
			processingMessage,
			processingError: null,
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(
			forceRestart
				? eq(videoUploads.videoId, videoId)
				: and(
						eq(videoUploads.videoId, videoId),
						ne(videoUploads.phase, "processing"),
					),
		);

	if (getAffectedRows(result) > 0) {
		return "started";
	}

	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));

	if (!upload) {
		throw new Error("No upload record found");
	}

	if (upload.phase === "processing") {
		return "already-processing";
	}

	throw new Error("Failed to transition upload to processing");
}

function getInputExtension(rawFileKey: string): string {
	const ext = rawFileKey.split(".").at(-1)?.toLowerCase();
	return ext ? `.${ext}` : ".mp4";
}

const MEDIA_SERVER_START_MAX_ATTEMPTS = 6;
const MEDIA_SERVER_START_RETRY_BASE_MS = 2000;

async function callMediaServerProcess(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		videoUrl: string;
		outputPresignedUrl: string;
		thumbnailPresignedUrl: string;
		webhookUrl: string;
		webhookSecret?: string;
		inputExtension: string;
	},
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const response = await fetch(`${mediaServerUrl}/video/process`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (response.ok) {
			const { jobId } = (await response.json()) as { jobId: string };
			return jobId;
		}

		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
		};
		const errorMessage = errorData.error || "Video processing failed to start";
		const shouldRetry =
			response.status === 503 && errorData.code === "SERVER_BUSY";

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await new Promise((resolve) =>
				setTimeout(resolve, MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt),
			);
			continue;
		}

		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

export async function startVideoProcessingDirect({
	videoId,
	userId,
	rawFileKey,
	bucketId,
	processingMessage,
	startFailureMessage,
	mode,
	forceRestart,
}: {
	videoId: Video.VideoId;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	processingMessage: string;
	startFailureMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
}): Promise<VideoProcessingStartStatus> {
	const status = await transitionVideoToProcessing({
		videoId,
		rawFileKey,
		processingMessage,
		mode,
		forceRestart,
	});

	if (status === "already-processing") {
		return status;
	}

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		const err = new Error("MEDIA_SERVER_URL is not configured");
		await setVideoProcessingError(videoId, startFailureMessage, err);
		throw err;
	}

	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId as S3Bucket.S3BucketId | null),
		).pipe(runPromise);

		const rawVideoUrl = await bucket
			.getInternalSignedObjectUrl(rawFileKey)
			.pipe(runPromise);

		const outputKey = `${userId}/${videoId}/result.mp4`;
		const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;

		const outputPresignedUrl = await bucket
			.getInternalPresignedPutUrl(outputKey, { ContentType: "video/mp4" })
			.pipe(runPromise);

		const thumbnailPresignedUrl = await bucket
			.getInternalPresignedPutUrl(thumbnailKey, { ContentType: "image/jpeg" })
			.pipe(runPromise);

		const webhookBaseUrl =
			serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
		const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
		const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress`;

		const jobId = await callMediaServerProcess(mediaServerUrl, {
			videoId,
			userId,
			videoUrl: rawVideoUrl,
			outputPresignedUrl,
			thumbnailPresignedUrl,
			webhookUrl,
			webhookSecret: webhookSecret || undefined,
			inputExtension: getInputExtension(rawFileKey),
		});

		console.log(
			`[video-processing] Media server job started: videoId=${videoId} jobId=${jobId} webhookUrl=${webhookUrl}`,
		);

		return "started";
	} catch (error) {
		const normalizedError =
			error instanceof Error
				? error
				: new Error("Video processing could not start");
		await setVideoProcessingError(
			videoId,
			startFailureMessage,
			normalizedError,
		);
		throw normalizedError;
	}
}
