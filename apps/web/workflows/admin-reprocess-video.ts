import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { AwsCredentials, Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { FatalError } from "workflow";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

interface AdminReprocessVideoWorkflowPayload {
	videoId: string;
}

interface MediaServerProcessResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
	ownerId: string;
	bucketId: string | null;
}

interface MediaServerJobBody {
	videoId: string;
	userId: string;
	videoUrl: string;
	outputPresignedUrl: string;
	thumbnailPresignedUrl: string;
	previewGifPresignedUrl: string;
	webhookUrl: string;
	webhookSecret?: string;
	inputExtension: string;
}

const MEDIA_SERVER_START_MAX_ATTEMPTS = 6;
const MEDIA_SERVER_START_RETRY_BASE_MS = 2000;
const MEDIA_SERVER_COMPLETION_MAX_ATTEMPTS = 720;
const MEDIA_SERVER_COMPLETION_POLL_INTERVAL_MS = 5000;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function isPositiveNumber(value: number | null): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function startMediaServerProcessJob(
	mediaServerUrl: string,
	body: MediaServerJobBody,
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
			details?: string;
			instanceId?: string;
			pid?: number;
			activeVideoProcesses?: number;
			maxConcurrentVideoProcesses?: number;
			jobCount?: number;
		};
		const baseErrorMessage =
			errorData.error ||
			errorData.details ||
			"Video reprocessing failed to start";
		const busyDiagnostics =
			errorData.code === "SERVER_BUSY"
				? [
						errorData.instanceId ? `instance=${errorData.instanceId}` : null,
						typeof errorData.pid === "number" ? `pid=${errorData.pid}` : null,
						typeof errorData.activeVideoProcesses === "number" &&
						typeof errorData.maxConcurrentVideoProcesses === "number"
							? `active=${errorData.activeVideoProcesses}/${errorData.maxConcurrentVideoProcesses}`
							: null,
						typeof errorData.jobCount === "number"
							? `jobCount=${errorData.jobCount}`
							: null,
					]
						.filter(Boolean)
						.join(", ")
				: "";
		const errorMessage = busyDiagnostics
			? `${baseErrorMessage} (${busyDiagnostics})`
			: baseErrorMessage;
		const shouldRetry =
			response.status === 503 &&
			(errorData.code === "SERVER_BUSY" ||
				errorMessage.includes("Server is busy"));

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await waitForRetry(MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		throw new Error(errorMessage);
	}

	throw new Error("Video reprocessing failed to start");
}

function getMetadataFromVideoRow(
	video:
		| {
				duration: number | null;
				width: number | null;
				height: number | null;
				fps: number | null;
		  }
		| undefined,
): MediaServerProcessResult["metadata"] | null {
	if (
		!video ||
		!isPositiveNumber(video.width) ||
		!isPositiveNumber(video.height) ||
		!isPositiveNumber(video.fps)
	) {
		return null;
	}

	return {
		duration: isPositiveNumber(video.duration) ? video.duration : 0,
		width: video.width,
		height: video.height,
		fps: video.fps,
	};
}

async function getCompletedMetadata(
	videoId: string,
): Promise<MediaServerProcessResult["metadata"] | null> {
	const [video] = await db()
		.select({
			duration: videos.duration,
			width: videos.width,
			height: videos.height,
			fps: videos.fps,
		})
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	return getMetadataFromVideoRow(video);
}

async function waitForProcessingCompletion(
	videoId: string,
): Promise<MediaServerProcessResult["metadata"]> {
	let lastStatus = "processing";

	for (
		let attempt = 0;
		attempt < MEDIA_SERVER_COMPLETION_MAX_ATTEMPTS;
		attempt++
	) {
		await waitForRetry(MEDIA_SERVER_COMPLETION_POLL_INTERVAL_MS);

		const [upload] = await db()
			.select({
				phase: videoUploads.phase,
				processingProgress: videoUploads.processingProgress,
				processingMessage: videoUploads.processingMessage,
				processingError: videoUploads.processingError,
			})
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId));

		if (!upload || upload.phase === "complete") {
			const metadata = await getCompletedMetadata(videoId);
			if (!metadata) {
				throw new Error("Reprocessing completed but video metadata is missing");
			}

			return metadata;
		}

		if (upload.processingError) {
			throw new Error(upload.processingError);
		}

		if (upload.phase === "error") {
			throw new Error(upload.processingMessage || "Video reprocessing failed");
		}

		lastStatus = [
			upload.phase,
			typeof upload.processingProgress === "number"
				? `${upload.processingProgress}%`
				: null,
			upload.processingMessage,
		]
			.filter(Boolean)
			.join(" ");
	}

	throw new Error(`Video reprocessing timed out while ${lastStatus}`);
}

async function validateReprocessRequest(videoId: string): Promise<void> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [video] = await db()
		.select({ id: videos.id })
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!video) {
		throw new FatalError("Video does not exist");
	}
}

async function processExistingResultOnMediaServer(
	videoId: string,
): Promise<MediaServerProcessResult> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const videoDomain = decodeStorageVideo(video);
	const [bucket] =
		await Storage.getAccessForVideo(videoDomain).pipe(runPromise);

	const resultKey = `${video.ownerId}/${video.id}/result.mp4`;
	const thumbnailKey = `${video.ownerId}/${video.id}/screenshot/screen-capture.jpg`;
	const previewGifKey = `${video.ownerId}/${video.id}/preview/animated-preview.gif`;

	const videoUrl = await bucket
		.getInternalSignedObjectUrl(resultKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runPromise);

	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			resultKey,
			{
				ContentType: "video/mp4",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runPromise);

	const thumbnailPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			thumbnailKey,
			{
				ContentType: "image/jpeg",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runPromise);

	const previewGifPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			previewGifKey,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress`;
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	await db()
		.insert(videoUploads)
		.values({
			videoId: video.id,
			uploaded: 0,
			total: 0,
			mode: "singlepart",
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting admin reprocess...",
			processingError: null,
			rawFileKey: resultKey,
			updatedAt: new Date(),
		})
		.onDuplicateKeyUpdate({
			set: {
				uploaded: 0,
				total: 0,
				mode: "singlepart",
				phase: "processing",
				processingProgress: 0,
				processingMessage: "Starting admin reprocess...",
				processingError: null,
				rawFileKey: resultKey,
				updatedAt: new Date(),
			},
		});

	await startMediaServerProcessJob(mediaServerUrl, {
		videoId,
		userId: video.ownerId,
		videoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		webhookUrl,
		webhookSecret: webhookSecret || undefined,
		inputExtension: ".mp4",
	});

	const metadata = await waitForProcessingCompletion(videoId);

	return {
		metadata,
		ownerId: video.ownerId,
		bucketId: video.bucket,
	};
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

async function invalidateResultCache(
	videoId: string,
	ownerId: string,
	bucketId: string | null,
): Promise<void> {
	"use step";

	if (bucketId) return;

	const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) return;

	const basePath = `/${ownerId}/${videoId}`;
	const paths = [
		`${basePath}/result.mp4`,
		`${basePath}/screenshot/screen-capture.jpg`,
		`${basePath}/preview/animated-preview.gif`,
	];

	try {
		const cloudfront = new CloudFrontClient({
			region: serverEnv().CAP_AWS_REGION || "us-east-1",
			credentials: await runPromise(
				Effect.map(AwsCredentials, (c) => c.credentials),
			),
		});

		await cloudfront.send(
			new CreateInvalidationCommand({
				DistributionId: distributionId,
				InvalidationBatch: {
					CallerReference: `admin-reprocess-${videoId}-${Date.now()}`,
					Paths: {
						Quantity: paths.length,
						Items: paths,
					},
				},
			}),
		);
	} catch (error) {
		console.warn("[adminReprocessVideoWorkflow] Failed to invalidate cache", {
			error,
			videoId,
		});
	}
}

async function setReprocessError(
	videoId: string,
	errorMessage: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: "Admin reprocess failed",
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}

export async function adminReprocessVideoWorkflow(
	payload: AdminReprocessVideoWorkflowPayload,
): Promise<{ success: boolean; message: string }> {
	"use workflow";

	const { videoId } = payload;

	try {
		await validateReprocessRequest(videoId);
		const result = await processExistingResultOnMediaServer(videoId);
		await saveMetadataAndComplete(videoId, result.metadata);
		await invalidateResultCache(videoId, result.ownerId, result.bucketId);

		return {
			success: true,
			message: "Video reprocessing completed",
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setReprocessError(videoId, errorMessage);
		throw new FatalError(errorMessage);
	}
}
