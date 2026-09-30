import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { agentApiOperations, videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { FatalError, sleep } from "workflow";
import {
	createMediaServerCapacityError,
	isMediaServerCapacityError,
} from "@/lib/media-server-backpressure";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import {
	type ProcessedVideoMetadata,
	VideoProcessingFailedError,
	waitForVideoProcessing,
} from "./video-processing-status";

interface ImportLoomPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	loomVideoId: string;
	loomDownloadUrl?: string;
	agentOperationId?: string;
	reuseExistingRawUpload?: boolean;
}

const MINIMUM_VIDEO_SIZE = 1024;
const MEDIA_SERVER_START_MAX_ATTEMPTS = 2;
const MEDIA_SERVER_START_RETRY_BASE_MS = 250;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

async function fetchLoomCdnUrl(
	videoId: string,
	endpoint: string,
	includeBody: boolean,
): Promise<string | null> {
	try {
		const options: RequestInit = {
			method: "POST",
			signal: AbortSignal.timeout(15_000),
		};
		if (includeBody) {
			options.headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			options.body = JSON.stringify({
				anonID: randomUUID(),
				deviceID: null,
				force_original: false,
				password: null,
			});
		}

		const response = await fetch(
			`https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
			options,
		);

		if (!response.ok || response.status === 204) return null;

		const text = await response.text();
		if (!text.trim()) return null;

		const data = JSON.parse(text) as { url?: string };
		return data.url ?? null;
	} catch {
		return null;
	}
}

async function fetchFreshLoomDownloadUrl(loomVideoId: string): Promise<string> {
	const requestVariants: Array<{ endpoint: string; includeBody: boolean }> = [
		{ endpoint: "transcoded-url", includeBody: true },
		{ endpoint: "raw-url", includeBody: true },
		{ endpoint: "transcoded-url", includeBody: false },
		{ endpoint: "raw-url", includeBody: false },
	];

	let fallbackStreamingUrl: string | null = null;

	for (const { endpoint, includeBody } of requestVariants) {
		const url = await fetchLoomCdnUrl(loomVideoId, endpoint, includeBody);
		if (!url) continue;

		if (!isStreamingUrl(url)) return url;

		if (!fallbackStreamingUrl) fallbackStreamingUrl = url;
	}

	if (fallbackStreamingUrl) return fallbackStreamingUrl;

	throw new FatalError(
		"Could not retrieve a download URL from Loom. The video may be private, password-protected, or the link may have expired.",
	);
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

interface LoomProcessingInput {
	importFromLoom?: boolean;
}

async function claimAgentImport(operationId: string | undefined) {
	"use step";

	if (!operationId) return true;
	return db().transaction(async (tx) => {
		const [operation] = await tx
			.select({
				kind: agentApiOperations.kind,
				state: agentApiOperations.state,
			})
			.from(agentApiOperations)
			.where(eq(agentApiOperations.id, operationId))
			.limit(1)
			.for("update");
		if (!operation || operation.kind !== "import_loom") {
			throw new FatalError("Agent Loom import operation not found");
		}
		if (operation.state !== "queued") return false;
		await tx
			.update(agentApiOperations)
			.set({ state: "running", updatedAt: new Date() })
			.where(eq(agentApiOperations.id, operationId));
		return true;
	});
}

async function completeAgentImport(
	operationId: string | undefined,
	videoId: string,
) {
	"use step";

	if (!operationId) return;
	const now = new Date();
	await db()
		.update(agentApiOperations)
		.set({
			state: "succeeded",
			result: { videoId },
			updatedAt: now,
			completedAt: now,
		})
		.where(eq(agentApiOperations.id, operationId));
}

async function failAgentImport(
	operationId: string | undefined,
	message: string,
) {
	"use step";

	if (!operationId) return;
	const now = new Date();
	await db()
		.update(agentApiOperations)
		.set({
			state: "failed",
			errorCode: "LOOM_IMPORT_FAILED",
			errorMessage: message.slice(0, 2_000),
			updatedAt: now,
			completedAt: now,
		})
		.where(eq(agentApiOperations.id, operationId));
}

export async function importLoomVideoWorkflow(
	payload: ImportLoomPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	if (!(await claimAgentImport(payload.agentOperationId))) {
		return { success: true, message: "Loom import is already running" };
	}
	try {
		const reuseExistingRawUpload =
			payload.reuseExistingRawUpload && (await hasExistingLoomUpload(payload));
		let processingInput: LoomProcessingInput = reuseExistingRawUpload
			? {}
			: { importFromLoom: true };

		let metadata: ProcessedVideoMetadata;
		for (let processingAttempt = 0; ; processingAttempt++) {
			let capacityRetryCount = 0;
			while (true) {
				try {
					await processVideoOnMediaServer(payload, processingInput);
					break;
				} catch (error) {
					if (!isMediaServerCapacityError(error)) throw error;
					await markLoomImportWaitingForCapacity(payload.videoId);
					await sleep(`${Math.min(180, 30 + capacityRetryCount * 15)}s`);
					capacityRetryCount++;
				}
			}
			try {
				metadata = await waitForVideoProcessing(payload.videoId);
				break;
			} catch (error) {
				if (
					!(error instanceof VideoProcessingFailedError) ||
					processingAttempt >= 2
				) {
					throw error;
				}
				await markLoomImportWaitingForCapacity(payload.videoId);
				if (await hasExistingLoomUpload(payload)) processingInput = {};
				await sleep(15_000 * (processingAttempt + 1));
			}
		}
		await saveMetadataAndComplete(payload.videoId, metadata);
		await completeAgentImport(payload.agentOperationId, payload.videoId);

		return {
			success: true,
			message: "Loom video imported successfully",
			metadata,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setProcessingError(payload.videoId, errorMessage);
		await failAgentImport(payload.agentOperationId, errorMessage);
		throw new FatalError(errorMessage);
	}
}

function getInputExtension(url: string): string | undefined {
	const pathname = new URL(url).pathname.toLowerCase();

	if (pathname.endsWith(".m3u8")) {
		return ".m3u8";
	}

	if (pathname.endsWith(".mpd")) {
		return ".mpd";
	}

	if (pathname.endsWith(".mp4")) {
		return ".mp4";
	}

	return undefined;
}

async function hasExistingLoomUpload(
	payload: ImportLoomPayload,
): Promise<boolean> {
	"use step";

	return Effect.gen(function* () {
		const [video] = yield* Effect.promise(() =>
			db()
				.select()
				.from(videos)
				.where(eq(videos.id, Video.VideoId.make(payload.videoId))),
		);
		if (!video) return false;
		const videoDomain = Video.Video.decodeSync({
			...video,
			bucketId: video.bucket,
			storageIntegrationId: video.storageIntegrationId,
			createdAt: video.createdAt.toISOString(),
			updatedAt: video.updatedAt.toISOString(),
			metadata: video.metadata,
		});
		const [bucket] = yield* Storage.getAccessForVideo(videoDomain);
		const object = yield* bucket.headObject(payload.rawFileKey);
		return (object.ContentLength ?? 0) >= MINIMUM_VIDEO_SIZE;
	}).pipe(
		Effect.catchAll(() => Effect.succeed(false)),
		runWorkflowPromise,
	);
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function startMediaServerProcessJob(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		videoUrl: string;
		sourcePresignedUrl?: string;
		outputPresignedUrl: string;
		thumbnailPresignedUrl: string;
		previewGifPresignedUrl: string;
		webhookUrl: string;
		webhookSecret?: string;
		inputExtension?: string;
		priority: "bulk";
	},
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const endpoint = body.sourcePresignedUrl ? "import" : "process";
		const response = await fetch(`${mediaServerUrl}/video/${endpoint}`, {
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
		};
		const errorMessage =
			errorData.error ||
			errorData.details ||
			"Video processing failed to start";
		const shouldRetry =
			response.status === 503 &&
			(errorData.code === "SERVER_BUSY" ||
				errorMessage.includes("Server is busy"));

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await waitForRetry(MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		if (shouldRetry) {
			throw createMediaServerCapacityError({
				response,
				message: errorMessage,
				videoId: body.videoId,
				priority: "bulk",
			});
		}

		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

async function processVideoOnMediaServer(
	payload: ImportLoomPayload,
	processingInput: LoomProcessingInput,
): Promise<void> {
	"use step";

	const { videoId, userId, rawFileKey, loomVideoId } = payload;

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;

	const loomSourceUrl = processingInput.importFromLoom
		? await fetchFreshLoomDownloadUrl(loomVideoId)
		: undefined;
	const {
		rawVideoUrl,
		sourcePresignedUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
	} = await Effect.gen(function* () {
		const [video] = yield* Effect.promise(() =>
			db()
				.select()
				.from(videos)
				.where(eq(videos.id, Video.VideoId.make(videoId))),
		);
		if (!video) {
			return yield* Effect.fail(new FatalError("Video does not exist"));
		}
		const videoDomain = Video.Video.decodeSync({
			...video,
			bucketId: video.bucket,
			storageIntegrationId: video.storageIntegrationId,
			createdAt: video.createdAt.toISOString(),
			updatedAt: video.updatedAt.toISOString(),
			metadata: video.metadata,
		});
		const [bucket] = yield* Storage.getAccessForVideo(videoDomain);
		const outputKey = `${userId}/${videoId}/result.mp4`;
		const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;
		const previewGifKey = `${userId}/${videoId}/preview/animated-preview.gif`;

		const rawVideoUrl = loomSourceUrl
			? loomSourceUrl
			: yield* bucket.getInternalSignedObjectUrl(rawFileKey, {
					expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
				});
		const sourcePresignedUrl =
			loomSourceUrl && !isStreamingUrl(loomSourceUrl)
				? yield* bucket.getInternalPresignedPutUrl(
						rawFileKey,
						{ ContentType: "video/mp4" },
						{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
					)
				: undefined;

		const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
			outputKey,
			{ ContentType: "video/mp4" },
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		);

		const thumbnailPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
			thumbnailKey,
			{
				ContentType: "image/jpeg",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		);

		const previewGifPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
			previewGifKey,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		);

		return {
			rawVideoUrl,
			sourcePresignedUrl,
			outputPresignedUrl,
			thumbnailPresignedUrl,
			previewGifPresignedUrl,
		};
	}).pipe(runWorkflowPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress?retryable=true`;
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video processing...",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	await startMediaServerProcessJob(mediaServerUrl, {
		videoId,
		userId,
		videoUrl: rawVideoUrl,
		sourcePresignedUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		webhookUrl,
		webhookSecret: webhookSecret || undefined,
		inputExtension: getInputExtension(rawVideoUrl),
		priority: "bulk",
	});
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
			fps: metadata.fps,
			...(getValidDuration(metadata.duration) === undefined
				? {}
				: { duration: metadata.duration }),
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	await db()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
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
			processingMessage: "Loom import failed",
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}

async function markLoomImportWaitingForCapacity(
	videoId: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			processingMessage: "Queued for Loom import processing...",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
