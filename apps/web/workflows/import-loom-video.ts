import { db } from "@cap/database";
import { agentApiOperations, videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
	createHook,
	FatalError,
	getWorkflowMetadata,
	RetryableError,
	sleep,
} from "workflow";
import {
	getLoomDownloadUrl,
	getReusableLoomDownloadUrl,
	LoomDownloadTemporaryError,
} from "@/lib/loom-download-url";
import { cleanupLoomFileSource } from "@/lib/loom-file-cleanup";
import { getLoomImportSignalToken } from "@/lib/loom-import-signal-token";
import {
	LOOM_IMPORT_MAX_BYTES,
	type LoomMultipartUploadTarget,
	prepareLoomMultipartUploads,
} from "@/lib/loom-import-upload";
import {
	isLoomMediaJobFailed,
	recordLoomMediaDispatch,
} from "@/lib/loom-media-dispatch";
import {
	createMediaServerCapacityError,
	isMediaServerCapacityError,
} from "@/lib/media-server-backpressure";
import { isStorageObjectNotFound } from "@/lib/storage-not-found";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import {
	type ProcessedVideoMetadata,
	VideoProcessingFailedError,
	waitForSignalledVideoProcessing,
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
	cleanupRawUpload?: boolean;
	importPriority?: "customer" | "bulk";
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

function isMp4Url(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mp4");
}

type LoomWorker = "importer" | "media";

function getLoomWorkerUrl(worker: LoomWorker): string | undefined {
	const env = serverEnv();
	return worker === "importer" ? env.LOOM_IMPORTER_URL : env.MEDIA_SERVER_URL;
}

async function fetchFreshLoomDownloadUrl(
	loomVideoId: string,
	existingUrl?: string,
): Promise<string> {
	"use step";

	const reusableUrl = getReusableLoomDownloadUrl(existingUrl);
	if (reusableUrl) return reusableUrl;
	try {
		const url = await getLoomDownloadUrl(loomVideoId);
		if (url) return url;
	} catch (error) {
		if (error instanceof LoomDownloadTemporaryError) {
			throw new RetryableError(error.message, {
				retryAfter: error.retryAfterMs,
			});
		}
		throw error;
	}
	throw new FatalError(
		"Could not retrieve a download URL from Loom. The video may be private, password-protected, or the link may have expired.",
	);
}

fetchFreshLoomDownloadUrl.maxRetries = 8;

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

async function requireLoomMediaServerSupport() {
	"use step";

	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL)
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	await requireLoomWorkerCapabilities(env.MEDIA_SERVER_URL);
	if (env.LOOM_IMPORTER_URL)
		await requireLoomWorkerCapabilities(env.LOOM_IMPORTER_URL);
}

requireLoomMediaServerSupport.maxRetries = 60;

async function requireLoomWorkerCapabilities(workerUrl: string) {
	const env = serverEnv();
	const response = await fetch(`${workerUrl}/video/status`, {
		headers: env.MEDIA_SERVER_WEBHOOK_SECRET
			? { "x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET }
			: undefined,
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok)
		throw new RetryableError(
			"Could not verify Loom import worker capabilities",
			{ retryAfter: 60_000 },
		);
	const capabilities: unknown = await response.json();
	if (
		typeof capabilities !== "object" ||
		capabilities === null ||
		!("loomMultipartUploads" in capabilities) ||
		capabilities.loomMultipartUploads !== true ||
		!("loomImportMaxBytes" in capabilities) ||
		capabilities.loomImportMaxBytes !== LOOM_IMPORT_MAX_BYTES
	) {
		throw new RetryableError(
			"The media server must be updated for 10 GB Loom imports",
			{ retryAfter: 60_000 },
		);
	}
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

	const { workflowRunId } = getWorkflowMetadata();
	if (!(await claimAgentImport(payload.agentOperationId))) {
		return { success: true, message: "Loom import is already running" };
	}
	try {
		const reuseExistingRawUpload =
			payload.reuseExistingRawUpload && (await hasExistingLoomUpload(payload));
		let processingInput: LoomProcessingInput = reuseExistingRawUpload
			? {}
			: { importFromLoom: true };
		await requireLoomMediaServerSupport();

		let metadata: ProcessedVideoMetadata;
		for (let processingAttempt = 0; ; processingAttempt++) {
			const finished = createHook<{ phase: string }>({
				token: getLoomImportSignalToken(
					payload.videoId,
					`${workflowRunId}:${processingAttempt}`,
				),
			});
			try {
				let mediaJob: { jobId: string; worker: LoomWorker };
				let capacityRetryCount = 0;
				let previousSourceUrl =
					processingAttempt === 0 ? payload.loomDownloadUrl : undefined;
				while (true) {
					try {
						const loomSourceUrl = processingInput.importFromLoom
							? await fetchFreshLoomDownloadUrl(
									payload.loomVideoId,
									previousSourceUrl,
								)
							: undefined;
						previousSourceUrl = loomSourceUrl;
						mediaJob = await processVideoOnMediaServer(
							payload,
							loomSourceUrl,
							`${workflowRunId}:${processingAttempt}`,
							workflowRunId,
						);
						break;
					} catch (error) {
						if (!isMediaServerCapacityError(error)) throw error;
						await markLoomImportWaitingForCapacity(payload.videoId);
						await sleep(`${Math.min(180, 30 + capacityRetryCount * 15)}s`);
						capacityRetryCount++;
					}
				}
				try {
					metadata = await waitForSignalledVideoProcessing(
						payload.videoId,
						finished,
					);
					break;
				} catch (error) {
					if (
						!(error instanceof VideoProcessingFailedError) ||
						processingAttempt >= 2
					) {
						throw error;
					}
					if (
						!(await confirmLoomMediaJobFailure(
							mediaJob.jobId,
							payload.videoId,
							mediaJob.worker,
						))
					) {
						throw new FatalError(
							"The previous Loom worker must be reconciled before retrying",
						);
					}
					await markLoomImportWaitingForCapacity(payload.videoId);
					if (await hasExistingLoomUpload(payload)) processingInput = {};
					await sleep(15_000 * (processingAttempt + 1));
				}
			} finally {
				finished.dispose();
			}
		}
		await saveMetadataAndComplete(payload.videoId, metadata);
		await completeAgentImport(payload.agentOperationId, payload.videoId);
		if (payload.cleanupRawUpload) await cleanupLoomFileSource(payload);

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

async function confirmLoomMediaJobFailure(
	jobId: string,
	videoId: string,
	worker: LoomWorker,
) {
	"use step";

	return isLoomMediaJobFailed(jobId, videoId, getLoomWorkerUrl(worker));
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
		const previous = video.metadata?.loomImportUpload;
		if (
			previous?.ownerId === video.ownerId &&
			previous.organizationId === video.orgId &&
			previous.output.key === `${video.ownerId}/${video.id}/result.mp4`
		) {
			const savedOutput = yield* bucket.headObject(previous.output.key).pipe(
				Effect.map(
					(object) => (object.ContentLength ?? 0) >= MINIMUM_VIDEO_SIZE,
				),
				Effect.catchIf(isStorageObjectNotFound, () => Effect.succeed(false)),
			);
			if (savedOutput) return true;
		}
		return yield* bucket.headObject(payload.rawFileKey).pipe(
			Effect.map((object) => (object.ContentLength ?? 0) >= MINIMUM_VIDEO_SIZE),
			Effect.catchIf(isStorageObjectNotFound, () => Effect.succeed(false)),
		);
	}).pipe(runWorkflowPromise);
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

class LoomMediaRequestRejectedError extends Error {}

async function startMediaServerProcessJob(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		videoUrl: string;
		sourcePresignedUrl?: string;
		sourceUpload?: LoomMultipartUploadTarget;
		outputUpload?: LoomMultipartUploadTarget;
		originalUpload?: {
			key: string;
			upload: LoomMultipartUploadTarget | { type: "put"; url: string };
		};
		existingOutput?: { url: string; objectIdentity: string; fileSize: number };
		maxImportBytes: number;
		outputPresignedUrl: string;
		thumbnailPresignedUrl: string;
		previewGifPresignedUrl?: string;
		webhookUrl: string;
		webhookSecret?: string;
		inputExtension?: string;
		priority: "bulk";
		importPriority?: "customer" | "bulk";
	},
	recordDispatch: (
		state: "accepted" | "rejected" | "uncertain",
		jobId?: string,
	) => Promise<void>,
	importOnly = false,
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const endpoint =
			importOnly || body.sourcePresignedUrl || body.sourceUpload
				? "import"
				: "process";
		await recordDispatch("uncertain");
		const response = await fetch(`${mediaServerUrl}/video/${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (response.ok) {
			const accepted: unknown = await response.json();
			if (
				typeof accepted !== "object" ||
				accepted === null ||
				!("jobId" in accepted) ||
				typeof accepted.jobId !== "string" ||
				!accepted.jobId
			) {
				throw new Error("Loom worker acceptance requires job reconciliation");
			}
			const jobId = accepted.jobId;
			await recordDispatch("accepted", jobId).catch((error) => {
				console.error("Could not record accepted Loom media dispatch", error);
			});
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
			response.status === 503 && errorData.code === "SERVER_BUSY";
		if ((response.status >= 400 && response.status < 500) || shouldRetry)
			await recordDispatch("rejected");

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

		if (response.status >= 400 && response.status < 500)
			throw new LoomMediaRequestRejectedError(errorMessage);
		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

async function processVideoOnMediaServer(
	payload: ImportLoomPayload,
	loomSourceUrl: string | undefined,
	attemptId: string,
	runId: string,
): Promise<{ jobId: string; worker: LoomWorker }> {
	"use step";

	const { videoId, userId, rawFileKey } = payload;

	const worker: LoomWorker =
		loomSourceUrl && serverEnv().LOOM_IMPORTER_URL ? "importer" : "media";
	const mediaServerUrl = getLoomWorkerUrl(worker);
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}
	const originalKey =
		worker === "importer" && loomSourceUrl && !isMp4Url(loomSourceUrl)
			? `${userId}/${videoId}/raw-upload.webm`
			: undefined;

	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;

	const {
		rawVideoUrl,
		originalUpload,
		sourcePresignedUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		sourceUpload,
		outputUpload,
		existingOutput,
		abortUploads,
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
		if (video.ownerId !== userId) {
			return yield* Effect.fail(new FatalError("Loom import owner changed"));
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
			worker === "media" && loomSourceUrl && !isStreamingUrl(loomSourceUrl)
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
		if (originalKey)
			yield* bucket
				.deleteObject(originalKey)
				.pipe(Effect.catchAll(() => Effect.void));
		const originalPutUrl =
			originalKey && bucket.provider !== "s3"
				? yield* bucket.getInternalPresignedPutUrl(originalKey, {
						ContentType: "video/webm",
					})
				: undefined;
		const multipart = yield* Effect.promise(() =>
			prepareLoomMultipartUploads({
				video,
				bucket,
				attemptId,
				sourceKey:
					worker === "importer"
						? originalKey
						: loomSourceUrl && !isStreamingUrl(loomSourceUrl)
							? rawFileKey
							: undefined,
				webhookBaseUrl,
				webhookSecret: serverEnv().MEDIA_SERVER_WEBHOOK_SECRET || undefined,
			}),
		);

		const originalUpload = originalKey
			? multipart.sourceUpload
				? { key: originalKey, upload: multipart.sourceUpload }
				: originalPutUrl
					? {
							key: originalKey,
							upload: { type: "put" as const, url: originalPutUrl },
						}
					: undefined
			: undefined;

		return {
			rawVideoUrl: multipart.existingOutput?.url ?? rawVideoUrl,
			originalUpload,
			sourcePresignedUrl:
				multipart.sourceUpload || multipart.existingOutput
					? undefined
					: sourcePresignedUrl,
			outputPresignedUrl,
			thumbnailPresignedUrl,
			previewGifPresignedUrl,
			...multipart,
			abortUploads: async () => {
				await Promise.all(
					[multipart.sourceUpload, multipart.outputUpload]
						.filter(
							(upload): upload is LoomMultipartUploadTarget =>
								upload !== undefined,
						)
						.map((upload) =>
							bucket.multipart.abort(upload.key, upload.uploadId).pipe(
								Effect.catchAll(() => Effect.void),
								runWorkflowPromise,
							),
						),
				);
			},
		};
	}).pipe(runWorkflowPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress?retryable=true&signal=${encodeURIComponent(getLoomImportSignalToken(videoId, attemptId))}${worker === "importer" ? "&transcription=on-view&preview=on-view" : ""}`;
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	try {
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
	} catch (error) {
		await abortUploads();
		throw error;
	}

	try {
		const jobId = await startMediaServerProcessJob(
			mediaServerUrl,
			{
				videoId,
				userId,
				videoUrl: rawVideoUrl,
				sourcePresignedUrl,
				sourceUpload: worker === "importer" ? undefined : sourceUpload,
				originalUpload,
				outputUpload,
				existingOutput,
				maxImportBytes: LOOM_IMPORT_MAX_BYTES,
				outputPresignedUrl,
				thumbnailPresignedUrl,
				previewGifPresignedUrl:
					worker === "importer" ? undefined : previewGifPresignedUrl,
				webhookUrl,
				webhookSecret: webhookSecret || undefined,
				inputExtension: getInputExtension(rawVideoUrl),
				priority: "bulk",
				importPriority:
					worker === "importer"
						? (payload.importPriority ?? "customer")
						: undefined,
			},
			(state, jobId) =>
				recordLoomMediaDispatch({
					videoId,
					userId,
					runId,
					attemptId,
					state,
					jobId,
					worker,
				}),
			worker === "importer",
		);
		return { jobId, worker };
	} catch (error) {
		if (error instanceof LoomMediaRequestRejectedError) await abortUploads();
		throw error;
	}
}

processVideoOnMediaServer.maxRetries = 0;

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
		.where(
			and(
				eq(videoUploads.videoId, videoId as Video.VideoId),
				sql`NOT EXISTS (SELECT 1 FROM ${videos} WHERE ${videos.id} = ${videoId} AND JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.status')) = 'started')`,
			),
		);
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
