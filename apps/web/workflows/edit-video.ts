import { createHash } from "node:crypto";
import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db } from "@cap/database";
import {
	comments,
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type {
	VideoEditRange,
	VideoEditSpec,
	VideoMetadata,
} from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { AwsCredentials } from "@cap/web-backend/src/Aws";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { FatalError } from "workflow";
import { transcribeVideo } from "@/lib/transcribe";
import {
	getEditSpecOutputDuration,
	remapCurrentOutputTimeThroughEdit,
} from "@/lib/video-edits";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface EditVideoWorkflowPayload {
	videoId: string;
	userId: string;
	sourceKey: string;
	previousSpec: VideoEditSpec;
	editSpec: VideoEditSpec;
	keepRanges: VideoEditRange[];
	aiGenerationEnabled: boolean;
}

interface VideoEditRenderResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

const MEDIA_SERVER_START_MAX_ATTEMPTS = 6;
const MEDIA_SERVER_START_RETRY_BASE_MS = 2000;
const MEDIA_SERVER_COMPLETION_MAX_ATTEMPTS = 720;
const MEDIA_SERVER_COMPLETION_POLL_INTERVAL_MS = 5000;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_OUTPUT_VERIFICATION_MAX_ATTEMPTS = 4;
const MEDIA_SERVER_OUTPUT_VERIFICATION_RETRY_MS = 1000;

function isPositiveNumber(value: number | null): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getDurationTolerance(duration: number) {
	if (!Number.isFinite(duration) || duration <= 0) return 0.5;
	return Math.max(0.5, Math.min(5, duration * 0.01));
}

function isDurationClose(actual: number, expected: number) {
	return (
		Number.isFinite(actual) &&
		Number.isFinite(expected) &&
		Math.abs(actual - expected) <= getDurationTolerance(expected)
	);
}

export async function editVideoWorkflow(
	payload: EditVideoWorkflowPayload,
): Promise<VideoEditRenderResult> {
	"use workflow";

	const {
		videoId,
		userId,
		sourceKey,
		previousSpec,
		editSpec,
		aiGenerationEnabled,
	} = payload;

	try {
		await validateEditRequest(videoId, sourceKey);
		const result = await renderVideoEditOnMediaServer(payload);
		await verifyRenderedEditOutput(videoId, userId, editSpec, result.metadata);
		await invalidateEditedVideoCache(videoId, editSpec);
		await saveEditResultAndComplete(
			videoId,
			sourceKey,
			previousSpec,
			editSpec,
			result.metadata,
		);
		await queueTranscriptionRegeneration(videoId, userId, aiGenerationEnabled);
		return result;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await clearEditProcessingState(videoId, sourceKey, previousSpec);
		throw new FatalError(errorMessage);
	}
}

async function validateEditRequest(
	videoId: string,
	sourceKey: string,
): Promise<void> {
	"use step";

	if (!serverEnv().MEDIA_SERVER_URL) {
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
		throw new FatalError("Edit render does not exist");
	}

	if (upload.rawFileKey !== sourceKey) {
		throw new FatalError("Edit source key does not match");
	}

	if (upload.phase !== "processing") {
		throw new FatalError("Video is not ready for edit rendering");
	}
}

async function startMediaServerEditJob(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		sourceUrl: string;
		outputPresignedUrl: string;
		outputVerificationUrl?: string;
		thumbnailPresignedUrl: string;
		previewGifPresignedUrl: string;
		webhookUrl: string;
		webhookSecret?: string;
		keepRanges: VideoEditRange[];
	},
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const response = await fetch(`${mediaServerUrl}/video/edit`, {
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
			errorData.error || errorData.details || "Video edit failed to start";
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

	throw new Error("Video edit failed to start");
}

async function renderVideoEditOnMediaServer(
	payload: EditVideoWorkflowPayload,
): Promise<VideoEditRenderResult> {
	"use step";

	const { videoId, userId, sourceKey, keepRanges } = payload;
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

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const sourceUrl = await bucket
		.getInternalSignedObjectUrl(sourceKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);

	const outputKey = `${userId}/${videoId}/result.mp4`;
	const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;
	const previewGifKey = `${userId}/${videoId}/preview/animated-preview.gif`;

	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			outputKey,
			{
				ContentType: "video/mp4",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const outputVerificationUrl = await bucket
		.getInternalSignedObjectUrl(outputKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);

	const thumbnailPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			thumbnailKey,
			{
				ContentType: "image/jpeg",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const previewGifPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			previewGifKey,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress?retryable=true`;
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video edit...",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	await startMediaServerEditJob(mediaServerUrl, {
		videoId,
		userId,
		sourceUrl,
		outputPresignedUrl,
		outputVerificationUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		webhookUrl,
		webhookSecret: webhookSecret || undefined,
		keepRanges,
	});

	return await waitForEditCompletion(videoId);
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
): VideoEditRenderResult["metadata"] | null {
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
): Promise<VideoEditRenderResult["metadata"] | null> {
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

async function probeVideoOnMediaServer(
	mediaServerUrl: string,
	videoUrl: string,
	webhookSecret: string | undefined,
): Promise<VideoEditRenderResult["metadata"]> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (webhookSecret) {
		headers["x-media-server-secret"] = webhookSecret;
	}

	const response = await fetch(`${mediaServerUrl}/video/probe`, {
		method: "POST",
		headers,
		body: JSON.stringify({ videoUrl }),
	});

	if (!response.ok) {
		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			details?: string;
		};
		throw new Error(
			errorData.error || errorData.details || "Rendered video probe failed",
		);
	}

	const { metadata } = (await response.json()) as VideoEditRenderResult;
	return metadata;
}

async function verifyRenderedEditOutput(
	videoId: string,
	userId: string,
	editSpec: VideoEditSpec,
	reportedMetadata: VideoEditRenderResult["metadata"],
): Promise<void> {
	"use step";

	const expectedDuration = getEditSpecOutputDuration(editSpec);
	if (!isDurationClose(reportedMetadata.duration, expectedDuration)) {
		throw new Error(
			`Media server reported edited duration ${reportedMetadata.duration.toFixed(3)}s, expected ${expectedDuration.toFixed(3)}s`,
		);
	}

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
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

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const outputKey = `${userId}/${videoId}/result.mp4`;
	const outputUrl = await bucket
		.getInternalSignedObjectUrl(outputKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);

	let lastError: Error | undefined;

	for (
		let attempt = 0;
		attempt < MEDIA_SERVER_OUTPUT_VERIFICATION_MAX_ATTEMPTS;
		attempt++
	) {
		try {
			const actualMetadata = await probeVideoOnMediaServer(
				mediaServerUrl,
				outputUrl,
				serverEnv().MEDIA_SERVER_WEBHOOK_SECRET || undefined,
			);
			if (isDurationClose(actualMetadata.duration, expectedDuration)) {
				return;
			}

			lastError = new Error(
				`Rendered video duration mismatch: expected ${expectedDuration.toFixed(3)}s, got ${actualMetadata.duration.toFixed(3)}s`,
			);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}

		if (attempt < MEDIA_SERVER_OUTPUT_VERIFICATION_MAX_ATTEMPTS - 1) {
			await waitForRetry(
				MEDIA_SERVER_OUTPUT_VERIFICATION_RETRY_MS * (attempt + 1),
			);
		}
	}

	throw lastError ?? new Error("Rendered video verification failed");
}

function clearAiMetadata(metadata: VideoMetadata | null): VideoMetadata {
	const nextMetadata = { ...(metadata ?? {}) };
	delete nextMetadata.summary;
	delete nextMetadata.chapters;
	delete nextMetadata.aiGenerationStatus;
	return nextMetadata;
}

async function queueTranscriptionRegeneration(
	videoId: string,
	userId: string,
	aiGenerationEnabled: boolean,
): Promise<void> {
	"use step";

	try {
		const result = await transcribeVideo(
			videoId as Video.VideoId,
			userId,
			aiGenerationEnabled,
		);

		if (!result.success) {
			console.warn("[editVideoWorkflow] Failed to queue transcription", {
				videoId,
				message: result.message,
			});
		}
	} catch (error) {
		console.warn("[editVideoWorkflow] Failed to queue transcription", error);
	}
}

async function clearTranscriptObjects(video: typeof videos.$inferSelect) {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const prefix = `${video.ownerId}/${video.id}/transcription`;
	const listed = await bucket.listObjects({ prefix }).pipe(runWorkflowPromise);
	const objects = (listed.Contents ?? [])
		.map((object) => ({ Key: object.Key }))
		.filter((object): object is { Key: string } => Boolean(object.Key));

	if (objects.length > 0) {
		await bucket.deleteObjects(objects).pipe(runWorkflowPromise);
	}
}

async function waitForEditCompletion(
	videoId: string,
): Promise<VideoEditRenderResult> {
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

		if (!upload) {
			throw new Error("Edit processing state disappeared");
		}

		if (upload.phase === "complete") {
			const metadata = await getCompletedMetadata(videoId);
			if (!metadata) {
				throw new Error("Edit completed but video metadata is missing");
			}

			return { metadata };
		}

		if (upload.processingError) {
			throw new Error(upload.processingError);
		}

		if (upload.phase === "error") {
			throw new Error(upload.processingMessage || "Video edit failed");
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

	throw new Error(`Video edit timed out while ${lastStatus}`);
}

function getEditInvalidationCallerReference(
	videoId: string,
	editSpec: VideoEditSpec,
) {
	const editHash = createHash("sha256")
		.update(JSON.stringify(editSpec))
		.digest("hex")
		.slice(0, 16);
	return `edit-${videoId}-${editHash}`;
}

async function invalidateEditedVideoCache(
	videoId: string,
	editSpec: VideoEditSpec,
): Promise<void> {
	"use step";

	const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) return;

	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			bucket: videos.bucket,
		})
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video || video.bucket) return;

	const basePath = `/${video.ownerId}/${videoId}`;
	const paths = [
		`${basePath}/result.mp4`,
		`${basePath}/screenshot/screen-capture.jpg`,
		`${basePath}/preview/animated-preview.gif`,
	];

	try {
		const cloudfront = new CloudFrontClient({
			region: serverEnv().CAP_AWS_REGION || "us-east-1",
			credentials: await runWorkflowPromise(
				Effect.map(AwsCredentials, (credentials) => credentials.credentials),
			),
		});

		await cloudfront.send(
			new CreateInvalidationCommand({
				DistributionId: distributionId,
				InvalidationBatch: {
					CallerReference: getEditInvalidationCallerReference(
						videoId,
						editSpec,
					),
					Paths: {
						Quantity: paths.length,
						Items: paths,
					},
				},
			}),
		);
	} catch (error) {
		console.warn(
			"[editVideoWorkflow] Failed to invalidate edited video cache",
			{
				error,
				videoId,
			},
		);
	}
}

async function saveEditResultAndComplete(
	videoId: string,
	sourceKey: string,
	previousSpec: VideoEditSpec,
	editSpec: VideoEditSpec,
	metadata: { duration: number; width: number; height: number; fps: number },
): Promise<void> {
	"use step";

	const duration = getValidDuration(metadata.duration);
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const nextMetadata = clearAiMetadata(video.metadata as VideoMetadata | null);

	await db().transaction(async (tx) => {
		await tx
			.update(videos)
			.set({
				width: metadata.width,
				height: metadata.height,
				fps: metadata.fps,
				metadata: nextMetadata,
				transcriptionStatus: null,
				...(duration === undefined ? {} : { duration }),
			})
			.where(eq(videos.id, videoId as Video.VideoId));

		await tx
			.insert(videoEdits)
			.values({
				videoId: videoId as Video.VideoId,
				sourceKey,
				editSpec,
				updatedAt: new Date(),
			})
			.onDuplicateKeyUpdate({
				set: {
					sourceKey,
					editSpec,
					updatedAt: new Date(),
				},
			});

		const timestampedComments = await tx
			.select({
				id: comments.id,
				timestamp: comments.timestamp,
			})
			.from(comments)
			.where(eq(comments.videoId, videoId as Video.VideoId));

		for (const comment of timestampedComments) {
			if (comment.timestamp === null) continue;
			const nextTimestamp = remapCurrentOutputTimeThroughEdit(
				comment.timestamp,
				previousSpec,
				editSpec,
			);
			if (nextTimestamp === comment.timestamp) continue;
			await tx
				.update(comments)
				.set({ timestamp: nextTimestamp })
				.where(eq(comments.id, comment.id));
		}

		await tx
			.delete(videoUploads)
			.where(
				and(
					eq(videoUploads.videoId, videoId as Video.VideoId),
					eq(videoUploads.phase, "complete"),
					eq(videoUploads.rawFileKey, sourceKey),
				),
			);
	});

	try {
		await clearTranscriptObjects(video);
	} catch (error) {
		console.warn(
			"[editVideoWorkflow] Failed to clear transcript objects",
			error,
		);
	}
}

async function clearEditProcessingState(
	videoId: string,
	sourceKey: string,
	previousSpec: VideoEditSpec,
): Promise<void> {
	"use step";

	const previousDuration = getValidDuration(
		getEditSpecOutputDuration(previousSpec),
	);

	await db().transaction(async (tx) => {
		if (previousDuration !== undefined) {
			await tx
				.update(videos)
				.set({ duration: previousDuration })
				.where(eq(videos.id, videoId as Video.VideoId));
		}

		await tx
			.delete(videoUploads)
			.where(
				and(
					eq(videoUploads.videoId, videoId as Video.VideoId),
					eq(videoUploads.rawFileKey, sourceKey),
				),
			);
	});
}
