import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { type User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { sleep } from "workflow";
import { z } from "zod";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import { observeDesktopRecordingJob } from "@/lib/desktop-recording-job-status";
import {
	attachRemoteJob,
	claimProcessingAttempt,
	type DesktopRecordingAttempt,
	type DesktopRecordingAttemptFence,
	deferWithoutMediaServer,
	ensureSegmentProcessingJob,
	getProcessingState,
	heartbeatAttempt,
	initializeSourceCommitCheckpoint,
	markSourceBlocked,
	persistCommittedSource,
	persistSourceCommitCheckpoint,
	scheduleRetry,
} from "@/lib/desktop-recording-jobs";
import {
	advanceDesktopRecordingSourceCommit,
	buildDesktopRecordingSourceUrls,
	getDesktopRecordingOutputKey,
} from "@/lib/desktop-recording-source";
import type { RecordingVerification } from "@/lib/desktop-recording-verification";
import { invalidateGoogleDriveStorageQuotaCache } from "@/lib/google-drive-storage-quota-cache";
import { transcribeVideo } from "@/lib/transcribe";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface FinalizeDesktopRecordingWorkflowPayload {
	videoId: string;
	userId: User.UserId;
	generation?: string;
	verification?: RecordingVerification;
}

type WorkflowResult = {
	success: boolean;
	jobId?: string;
	reason?:
		| "source-blocked"
		| "superseded"
		| "already-processing"
		| "media-server-unconfigured";
};

type DesktopSegmentsOutputUpload =
	| { type: "put"; url: string; ifNoneMatch: "*" }
	| {
			type: "multipart";
			videoId: string;
			generation: string;
			attemptId: string;
			key: string;
			uploadId: string;
			partSize: number;
			signPartUrl: string;
			completeUrl: string;
			abortUrl: string;
			webhookSecret?: string;
	  };

const COMPLETION_POLL_INTERVAL_MS = 15_000;
const ATTEMPT_MAX_DURATION_MS = 6 * 60 * 60 * 1_000;
const PRESIGNED_EXPIRES_SECONDS = 6 * 60 * 60;
const MULTIPART_OUTPUT_PART_SIZE_BYTES = 64 * 1024 * 1024;

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function getSourceErrorCode(error: unknown) {
	if (error && typeof error === "object" && "code" in error) {
		const code = error.code;
		if (
			code === "source-incomplete" ||
			code === "source-missing" ||
			code === "source-changed" ||
			code === "source-invalid"
		) {
			return code;
		}
	}
	return null;
}

function getMediaServerWebhookUrl(baseUrl: string, path: string) {
	const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(path.replace(/^\//, ""), normalizedBaseUrl).toString();
}

export async function finalizeDesktopRecordingWorkflow(
	payload: FinalizeDesktopRecordingWorkflowPayload,
): Promise<WorkflowResult> {
	"use workflow";

	const generation = await ensureWorkflowJob(payload);
	let completedJobId: string | undefined;
	let mediaServerUnavailable = false;
	processing: for (;;) {
		const next = await acquireDesktopRecordingAttempt({
			...payload,
			generation,
		});
		if (next.status === "verified") break;
		if (next.status === "wait") {
			await sleep(next.until);
			continue;
		}
		if (next.status !== "attempt") {
			return { success: false, reason: next.status };
		}
		const attempt = next.attempt;
		try {
			let committed = await commitDesktopRecordingAttempt(attempt);
			while (committed === "progress") {
				committed = await commitDesktopRecordingAttempt(attempt);
			}
			if (committed !== "ready") {
				return { success: false, reason: committed };
			}
			if (await completeWithoutMediaServerIfUnavailable(attempt)) {
				mediaServerUnavailable = true;
				break;
			}
			const jobId = await startDesktopRecordingJob(attempt);
			for (;;) {
				await sleep(COMPLETION_POLL_INTERVAL_MS);
				const status = await pollDesktopRecordingAttempt({
					videoId: attempt.videoId,
					generation: attempt.generation,
					attemptId: attempt.attemptId,
					jobId,
					deadline: new Date(
						attempt.updatedAt.getTime() + ATTEMPT_MAX_DURATION_MS,
					),
				});
				if (status === "verified") {
					completedJobId = jobId;
					break processing;
				}
				if (status === "waiting") continue;
				if (status === "retry") break;
				return { success: false, jobId, reason: status };
			}
		} catch (error) {
			const retained = await retryDesktopRecordingAttempt(
				attempt,
				getErrorMessage(error),
				getSourceErrorCode(error),
			);
			if (retained !== "retry") return { success: false, reason: retained };
		}
	}
	for (let attempt = 0; ; attempt++) {
		let queued: boolean;
		try {
			queued = await queueFinalizedRecordingTranscription(
				payload.videoId,
				payload.userId,
			);
		} catch {
			queued = false;
		}
		if (queued) break;
		await sleep(Math.min(15_000 * 2 ** Math.min(attempt, 5), 300_000));
	}
	return mediaServerUnavailable
		? { success: false, reason: "media-server-unconfigured" }
		: { success: true, ...(completedJobId ? { jobId: completedJobId } : {}) };
}

async function ensureWorkflowJob(
	payload: FinalizeDesktopRecordingWorkflowPayload,
): Promise<string> {
	"use step";

	if (payload.generation) return payload.generation;
	const { job } = await ensureSegmentProcessingJob({
		videoId: Video.VideoId.make(payload.videoId),
		userId: payload.userId,
		verification: payload.verification,
	});
	return job.generation;
}

export async function acquireDesktopRecordingAttempt({
	videoId,
	userId,
	generation,
}: {
	videoId: string;
	userId: User.UserId;
	generation: string;
}): Promise<
	| { status: "attempt"; attempt: DesktopRecordingAttempt }
	| { status: "wait"; until: Date }
	| {
			status:
				| "verified"
				| "source-blocked"
				| "superseded"
				| "already-processing";
	  }
> {
	"use step";

	const id = Video.VideoId.make(videoId);
	const job = await getProcessingState({ videoId: id, generation });
	if (!job || job.ownerId !== userId) return { status: "superseded" };
	if (job.state === "verified") return { status: "verified" };
	if (job.state === "source-blocked") return { status: "source-blocked" };
	const now = new Date();
	if (job.leaseExpiresAt && job.leaseExpiresAt > now) {
		return { status: "already-processing" };
	}
	if (job.nextRetryAt > now) return { status: "wait", until: job.nextRetryAt };
	const attempt = await claimProcessingAttempt({
		videoId: id,
		generation,
		now,
	});
	return attempt
		? { status: "attempt", attempt }
		: { status: "already-processing" };
}

export async function commitDesktopRecordingAttempt(
	attempt: DesktopRecordingAttempt,
): Promise<"progress" | "ready" | "source-blocked" | "superseded"> {
	"use step";

	const current = await getProcessingState(attempt);
	if (!current || current.attemptId !== attempt.attemptId) return "superseded";
	if (current.source) return "ready";
	const [video] = await db()
		.select()
		.from(videos)
		.where(
			and(eq(videos.id, attempt.videoId), eq(videos.ownerId, attempt.ownerId)),
		);
	if (!video) return "superseded";
	try {
		const checkpoint = await initializeSourceCommitCheckpoint(attempt);
		if (!checkpoint) return "superseded";
		const result = await advanceDesktopRecordingSourceCommit(
			video,
			checkpoint,
			current.verification ?? undefined,
			async () => {
				if (!(await heartbeatAttempt(attempt))) {
					throw new Error("Recording source commit lease was superseded");
				}
			},
		);
		if ("checkpoint" in result) {
			return (await persistSourceCommitCheckpoint(attempt, result.checkpoint))
				? "progress"
				: "superseded";
		}
		return (await persistCommittedSource(attempt, result.source))
			? "ready"
			: "superseded";
	} catch (error) {
		const code = getSourceErrorCode(error);
		if (!code) throw error;
		const marked = await markSourceBlocked({
			...attempt,
			errorCode: code,
			errorMessage: getErrorMessage(error),
		});
		return marked ? "source-blocked" : "superseded";
	}
}

async function completeWithoutMediaServerIfUnavailable(
	attempt: DesktopRecordingAttempt,
): Promise<boolean> {
	"use step";

	if (serverEnv().MEDIA_SERVER_URL) return false;
	const deferred = await deferWithoutMediaServer(attempt);
	if (deferred) {
		const [video] = await db()
			.select({ storageIntegrationId: videos.storageIntegrationId })
			.from(videos)
			.where(eq(videos.id, attempt.videoId));
		await invalidateGoogleDriveStorageQuotaCache(video?.storageIntegrationId);
	}
	return true;
}

async function buildDesktopSegmentsOutput({
	video,
	attempt,
}: {
	video: typeof videos.$inferSelect;
	attempt: DesktopRecordingAttemptFence;
}) {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const outputKey = getDesktopRecordingOutputKey(
		video.ownerId,
		video.id,
		attempt.generation,
		attempt.attemptId,
	);
	const candidateDirectory = outputKey.slice(0, -4);
	const env = serverEnv();
	const webhookBaseUrl = env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL;
	const webhookSecret = env.MEDIA_SERVER_WEBHOOK_SECRET;
	const outputVerificationUrl = await bucket
		.getInternalSignedObjectUrl(outputKey, {
			expiresIn: PRESIGNED_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);
	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			outputKey,
			{ ContentType: "video/mp4" },
			{ expiresIn: PRESIGNED_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);
	let outputUpload: DesktopSegmentsOutputUpload = {
		type: "put",
		url: outputPresignedUrl,
		ifNoneMatch: "*",
	};
	if (bucket.provider === "s3" && webhookSecret) {
		const multipart = await bucket.multipart
			.create(outputKey, { ContentType: "video/mp4" })
			.pipe(runWorkflowPromise);
		if (!multipart.UploadId)
			throw new Error("Storage did not return a multipart upload id");
		outputUpload = {
			type: "multipart",
			videoId: video.id,
			generation: attempt.generation,
			attemptId: attempt.attemptId,
			key: outputKey,
			uploadId: multipart.UploadId,
			partSize: MULTIPART_OUTPUT_PART_SIZE_BYTES,
			signPartUrl: getMediaServerWebhookUrl(
				webhookBaseUrl,
				"/api/webhooks/media-server/multipart/sign-part",
			),
			completeUrl: getMediaServerWebhookUrl(
				webhookBaseUrl,
				"/api/webhooks/media-server/multipart/complete",
			),
			abortUrl: getMediaServerWebhookUrl(
				webhookBaseUrl,
				"/api/webhooks/media-server/multipart/abort",
			),
			webhookSecret,
		};
	}
	const thumbnailPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			`${candidateDirectory}/screenshot.jpg`,
			{ ContentType: "image/jpeg" },
			{ expiresIn: PRESIGNED_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);
	const previewGifPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			`${candidateDirectory}/preview.gif`,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: PRESIGNED_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);
	return {
		outputKey,
		outputVerificationUrl,
		outputPresignedUrl,
		outputUpload,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
	};
}

export async function startDesktopRecordingJob(
	attempt: DesktopRecordingAttempt,
): Promise<string> {
	"use step";

	const current = await getProcessingState(attempt);
	if (!current || current.attemptId !== attempt.attemptId || !current.source) {
		throw new Error("Recording processing attempt was superseded");
	}
	if (current.remoteJobId) return current.remoteJobId;
	const [video] = await db()
		.select()
		.from(videos)
		.where(
			and(eq(videos.id, current.videoId), eq(videos.ownerId, current.ownerId)),
		);
	if (!video) throw new Error("Recording does not exist");
	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL || !env.MEDIA_SERVER_WEBHOOK_SECRET) {
		throw new Error("Recording content verification is not configured");
	}
	const urls = await buildDesktopRecordingSourceUrls(
		video,
		current.source,
	).catch(async (error: unknown) => {
		const code = getSourceErrorCode(error);
		if (code) {
			await markSourceBlocked({
				...attempt,
				errorCode: code,
				errorMessage: getErrorMessage(error),
			});
		}
		throw error;
	});
	const webhookBaseUrl = env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL;
	const context = {
		videoId: current.videoId,
		userId: current.ownerId,
		generation: current.generation,
		attemptId: attempt.attemptId,
		inventorySha256: current.source.inventorySha256,
		requiredAudio:
			current.source.requiredAudio ||
			current.verification?.requiredAudio === true,
		webhookUrl: getMediaServerWebhookUrl(
			webhookBaseUrl,
			"/api/webhooks/media-server/progress?retryable=true",
		),
		webhookSecret: env.MEDIA_SERVER_WEBHOOK_SECRET,
	};
	let path: string;
	let body: Record<string, unknown>;
	if (current.source.kind === "mp4") {
		const mp4 = current.source.mp4;
		if (
			!mp4 ||
			!urls.videoUrl ||
			!urls.sourceObjectIdentity ||
			!urls.outputKey
		) {
			throw new Error("Committed MP4 source is missing its immutable identity");
		}
		path = "/video/verify-recording";
		body = {
			...context,
			...urls,
			fileSize: mp4.fileSize,
			duration:
				current.verification?.artifact.kind === "mp4"
					? current.verification.artifact.duration
					: mp4.duration,
			objectIdentity: mp4.objectIdentity,
			originalObjectIdentity: mp4.objectIdentity,
			outputKey: urls.outputKey,
		};
	} else {
		if (!urls.videoInitUrl || !urls.videoSegmentUrls?.length) {
			throw new Error(
				"Committed segmented source is missing its video inventory",
			);
		}
		path = "/video/mux-segments";
		body = {
			...context,
			...urls,
			...(await buildDesktopSegmentsOutput({ video, attempt })),
			manifestSha256: current.source.manifestSha256,
		};
	}
	const response = await fetch(
		`${env.MEDIA_SERVER_URL.replace(/\/$/, "")}${path}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Failed to start recording processing: ${response.status} ${detail}`,
		);
	}
	const result = z
		.object({ jobId: z.string().min(1) })
		.parse(await response.json());
	if (!(await attachRemoteJob({ ...attempt, remoteJobId: result.jobId }))) {
		throw new Error(
			"Recording processing attempt expired before the worker was attached",
		);
	}
	return result.jobId;
}

export async function pollDesktopRecordingAttempt({
	jobId,
	deadline,
	...fence
}: DesktopRecordingAttemptFence & {
	jobId: string;
	deadline: Date;
}): Promise<
	"waiting" | "verified" | "retry" | "source-blocked" | "superseded"
> {
	"use step";

	let current = await getProcessingState(fence);
	if (!current) return "superseded";
	if (current.state === "verified") return "verified";
	if (current.attemptId !== fence.attemptId) return "superseded";
	if (current.state === "source-blocked") return "source-blocked";
	if (current.state === "retry") return "retry";
	const now = new Date();
	if (now >= deadline) {
		return (await scheduleRetry({
			...fence,
			errorCode: "processing-timeout",
			errorMessage:
				"Processing did not finish within its attempt lease; source files are retained.",
			now,
		}))
			? "retry"
			: "superseded";
	}
	const env = serverEnv();
	if (env.MEDIA_SERVER_URL && current.source) {
		const observation = await observeDesktopRecordingJob({
			...fence,
			jobId,
			inventorySha256: current.source.inventorySha256,
			mediaServerUrl: env.MEDIA_SERVER_URL,
			webhookUrl: getMediaServerWebhookUrl(
				env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL,
				"/api/webhooks/media-server/progress?retryable=true",
			),
			secret: env.MEDIA_SERVER_WEBHOOK_SECRET,
		});
		if (observation.status === "active") await heartbeatAttempt(fence);
	}
	current = await getProcessingState(fence);
	if (!current) return "superseded";
	if (current.state === "verified") return "verified";
	if (current.attemptId !== fence.attemptId) return "superseded";
	if (current.state === "source-blocked") return "source-blocked";
	if (current.state === "retry") return "retry";
	if (!current.leaseExpiresAt || current.leaseExpiresAt <= new Date()) {
		return (await scheduleRetry({
			...fence,
			errorCode: "worker-lease-expired",
			errorMessage:
				"Processing worker is unavailable. Retrying from the retained recording source.",
		}))
			? "retry"
			: "superseded";
	}
	return "waiting";
}

async function retryDesktopRecordingAttempt(
	attempt: DesktopRecordingAttemptFence,
	errorMessage: string,
	sourceErrorCode: ReturnType<typeof getSourceErrorCode>,
): Promise<"retry" | "source-blocked" | "superseded"> {
	"use step";

	const current = await getProcessingState(attempt);
	if (!current || current.attemptId !== attempt.attemptId) return "superseded";
	if (current.state === "source-blocked") return "source-blocked";
	if (sourceErrorCode) {
		return (await markSourceBlocked({
			...attempt,
			errorCode: sourceErrorCode,
			errorMessage,
		}))
			? "source-blocked"
			: "superseded";
	}
	return (await scheduleRetry({
		...attempt,
		errorCode: "processing-interrupted",
		errorMessage,
	}))
		? "retry"
		: "superseded";
}

async function queueFinalizedRecordingTranscription(
	videoId: string,
	userId: User.UserId,
): Promise<boolean> {
	"use step";

	if (!serverEnv().ASSEMBLY_API_KEY) return true;
	try {
		const [[owner], [video]] = await Promise.all([
			db()
				.select({
					email: users.email,
					stripeSubscriptionStatus: users.stripeSubscriptionStatus,
					thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
				})
				.from(users)
				.where(eq(users.id, userId)),
			db()
				.select({ id: videos.id })
				.from(videos)
				.where(
					and(
						eq(videos.id, Video.VideoId.make(videoId)),
						eq(videos.ownerId, userId),
					),
				),
		]);
		if (!owner || !video) return true;
		const result = await transcribeVideo(
			Video.VideoId.make(videoId),
			userId,
			isAiGenerationEnabledForUser(owner),
		);
		if (result.success) return true;
		console.warn(
			"[finalizeDesktopRecordingWorkflow] Transcription enqueue will retry",
			{ videoId, message: result.message },
		);
	} catch (error) {
		console.warn(
			"[finalizeDesktopRecordingWorkflow] Transcription enqueue interrupted",
			{ videoId, error: getErrorMessage(error) },
		);
	}
	return false;
}
