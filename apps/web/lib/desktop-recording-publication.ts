import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	DESKTOP_RECORDING_LEASE_MS,
	DESKTOP_RECORDING_SOURCE_RETRY_MS,
	type DesktopRecordingJob,
	getDesktopRecordingRetryDelay,
	getDesktopRecordingWorkerCheckpoint,
	getProcessingState,
	parseDesktopRecordingJob,
} from "@/lib/desktop-recording-jobs";
import { getDesktopRecordingOutputKey } from "@/lib/desktop-recording-source";
import {
	createVerifiedRecordingReceipt,
	type RecordingReceiptOptions,
} from "@/lib/desktop-recording-upload-status";
import {
	recordingObjectIdentitySchema,
	recordingOutputSchema,
	recordingOutputSha256Schema,
	recordingSourceProofSchema,
	recordingVerificationSchema,
} from "@/lib/desktop-recording-verification";
import { invalidateGoogleDriveStorageQuotaCache } from "@/lib/google-drive-storage-quota-cache";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export const desktopRecordingProgressSchema = z.object({
	jobId: z.string().min(1),
	videoId: z.string().min(1),
	generation: z.string().min(1),
	attemptId: z.string().min(1),
	inventorySha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	manifestSha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	recordingWorker: z
		.object({
			version: z.literal(1),
			action: z.enum(["claim", "progress"]),
			sequence: z.number().int().nonnegative().safe(),
		})
		.optional(),
	phase: z.enum([
		"queued",
		"downloading",
		"probing",
		"processing",
		"uploading",
		"generating_thumbnail",
		"complete",
		"error",
		"cancelled",
	]),
	progress: z.number().finite().min(0).max(100),
	message: z.string().optional(),
	error: z.string().optional(),
	errorCode: z.string().optional(),
	metadata: recordingOutputSchema
		.extend({ fps: z.number().finite().nonnegative() })
		.optional(),
	recordingVerification: z
		.object({
			request: recordingVerificationSchema,
			fullDecode: z.literal(true),
			objectIdentity: recordingObjectIdentitySchema,
			outputKey: z.string().min(1),
			outputSha256: recordingOutputSha256Schema,
			sourceProof: recordingSourceProofSchema.optional(),
		})
		.optional(),
});

type RecordingProgress = z.infer<typeof desktopRecordingProgressSchema>;

type RecordingWorkerAcknowledgement = {
	version: 1;
	status: "accepted" | "owned" | "superseded" | "stale";
	generation: string;
	attemptId: string;
	jobId: string;
	sequence: number;
	ownerJobId?: string;
	leaseDurationMs?: number;
};

function workerAcknowledgement(
	payload: RecordingProgress,
	status: RecordingWorkerAcknowledgement["status"],
	options: Pick<
		RecordingWorkerAcknowledgement,
		"ownerJobId" | "leaseDurationMs"
	> = {},
) {
	return {
		handled: true,
		status: 200 as const,
		recordingWorker: {
			version: 1 as const,
			status,
			generation: payload.generation,
			attemptId: payload.attemptId,
			jobId: payload.jobId,
			sequence: payload.recordingWorker?.sequence ?? 0,
			...options,
		},
	};
}

function workerCheckpoint(payload: RecordingProgress, now = new Date()) {
	return {
		version: 1 as const,
		kind: "recording-worker" as const,
		generation: payload.generation,
		attemptId: payload.attemptId,
		jobId: payload.jobId,
		sequence: payload.recordingWorker?.sequence ?? 0,
		phase: payload.phase,
		progress: payload.progress,
		payloadSha256: createHash("sha256")
			.update(JSON.stringify(payload))
			.digest("hex"),
		updatedAt: now.toISOString(),
		stateChangedAt: now.toISOString(),
	};
}

function workerDisposition(
	job: DesktopRecordingJob,
	payload: RecordingProgress,
	now = new Date(),
) {
	const worker = payload.recordingWorker;
	if (!worker) return "superseded" as const;
	if (
		job.generation !== payload.generation ||
		job.attemptId !== payload.attemptId
	)
		return "superseded" as const;
	if (job.remoteJobId !== null && job.remoteJobId !== payload.jobId)
		return "owned" as const;
	const checkpoint = getDesktopRecordingWorkerCheckpoint(job);
	const terminal = ["complete", "error", "cancelled"].includes(payload.phase);
	const duplicate =
		checkpoint?.sequence === worker.sequence &&
		checkpoint.payloadSha256 === workerCheckpoint(payload, now).payloadSha256;
	if (duplicate && terminal && job.state !== "processing")
		return "terminal" as const;
	if (!job.source || !isCurrentDesktopRecordingAttempt(job, payload, now))
		return "superseded" as const;
	if (
		payload.inventorySha256 !== job.source.inventorySha256 ||
		(job.source.kind === "segments" &&
			payload.manifestSha256 !== job.source.manifestSha256)
	)
		return "superseded" as const;
	if (checkpoint) {
		if (
			worker.sequence < checkpoint.sequence ||
			(worker.sequence === checkpoint.sequence && !duplicate)
		)
			return "stale" as const;
		if (duplicate) return "repeat" as const;
		if (worker.action !== "progress") return "stale" as const;
		return "advance" as const;
	}
	if (
		job.remoteJobId !== null ||
		worker.action !== "claim" ||
		worker.sequence !== 0 ||
		payload.phase !== "queued" ||
		payload.progress !== 0
	)
		return "superseded" as const;
	return "advance" as const;
}

async function applyActiveRecordingProgress(payload: RecordingProgress) {
	const videoId = Video.VideoId.make(payload.videoId);
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(videoProcessingJobs)
			.where(eq(videoProcessingJobs.videoId, videoId))
			.for("update");
		const legacyResponse = { handled: true, status: 200 as const };
		if (!row)
			return payload.recordingWorker
				? workerAcknowledgement(payload, "superseded")
				: legacyResponse;
		const job = parseDesktopRecordingJob(row);
		const now = new Date();
		const disposition = payload.recordingWorker
			? workerDisposition(job, payload, now)
			: isCurrentDesktopRecordingAttempt(job, payload, now) &&
					!getDesktopRecordingWorkerCheckpoint(job)
				? "advance"
				: "superseded";
		if (disposition === "terminal")
			return workerAcknowledgement(payload, "accepted");
		if (disposition !== "advance" && disposition !== "repeat")
			return payload.recordingWorker
				? workerAcknowledgement(
						payload,
						disposition,
						job.remoteJobId ? { ownerJobId: job.remoteJobId } : {},
					)
				: legacyResponse;
		const failed = payload.phase === "error" || payload.phase === "cancelled";
		const errorCode = payload.errorCode ?? "processing-unavailable";
		const blocked =
			failed &&
			["source-invalid", "source-missing", "source-changed"].includes(
				errorCode,
			);
		await tx
			.update(videoProcessingJobs)
			.set({
				...(payload.recordingWorker ? { remoteJobId: payload.jobId } : {}),
				leaseExpiresAt: failed
					? null
					: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
				updatedAt: now,
				...(payload.recordingWorker && disposition === "advance"
					? { output: workerCheckpoint(payload, now) }
					: {}),
				...(failed
					? {
							state: blocked ? ("source-blocked" as const) : ("retry" as const),
							nextRetryAt: new Date(
								now.getTime() +
									(blocked
										? DESKTOP_RECORDING_SOURCE_RETRY_MS
										: getDesktopRecordingRetryDelay(job.attemptCount)),
							),
							errorCode,
							errorMessage:
								payload.error ??
								payload.message ??
								"Recording processing was interrupted",
						}
					: {}),
			})
			.where(eq(videoProcessingJobs.videoId, videoId));
		if (disposition === "advance") {
			await tx
				.update(videoUploads)
				.set({
					phase: blocked
						? "error"
						: payload.phase === "generating_thumbnail"
							? "generating_thumbnail"
							: "processing",
					processingProgress: Math.round(payload.progress),
					processingMessage: blocked
						? "Waiting for complete recording source. Uploaded files are retained."
						: failed
							? "Processing interrupted. Retrying automatically..."
							: (payload.message ?? "Verifying and processing recording..."),
					processingError: blocked
						? `${errorCode}: ${payload.error ?? payload.message ?? "Recording source is unavailable"}`
						: null,
					updatedAt: now,
				})
				.where(eq(videoUploads.videoId, videoId));
		}
		return payload.recordingWorker
			? workerAcknowledgement(
					payload,
					"accepted",
					failed ? {} : { leaseDurationMs: DESKTOP_RECORDING_LEASE_MS },
				)
			: legacyResponse;
	});
}

export function isCurrentDesktopRecordingAttempt(
	job: DesktopRecordingJob,
	payload: Pick<RecordingProgress, "generation" | "attemptId" | "jobId">,
	now = new Date(),
) {
	return (
		job.generation === payload.generation &&
		job.attemptId === payload.attemptId &&
		job.state === "processing" &&
		(job.remoteJobId === null || job.remoteJobId === payload.jobId) &&
		job.leaseExpiresAt !== null &&
		job.leaseExpiresAt > now
	);
}

export function validateDesktopRecordingCompletion(
	job: DesktopRecordingJob,
	payload: RecordingProgress,
) {
	const proof = payload.recordingVerification;
	const source = job.source;
	if (!proof || !source || !payload.metadata || !job.attemptId) {
		throw new Error(
			"Recording completion has no committed source or verified output",
		);
	}
	const request = job.verification ?? proof.request;
	if (!isDeepStrictEqual(request.artifact, proof.request.artifact)) {
		throw new Error(
			"Recording output does not match the current verification request",
		);
	}
	const options: RecordingReceiptOptions = {
		outputKey: proof.outputKey,
		outputSha256: proof.outputSha256,
	};
	if (source.kind === "segments") {
		const expectedKey = getDesktopRecordingOutputKey(
			job.ownerId,
			job.videoId,
			job.generation,
			job.attemptId,
		);
		if (
			proof.outputKey !== expectedKey ||
			request.artifact.kind !== "segments" ||
			request.artifact.manifestSha256 !== source.manifestSha256 ||
			proof.sourceProof?.manifestSha256 !== source.manifestSha256 ||
			proof.sourceProof?.inventorySha256 !== source.inventorySha256 ||
			!proof.sourceProof.sourcePreserved ||
			(source.requiredAudio &&
				(!proof.sourceProof.hasAudio || !proof.sourceProof.audioVerified))
		) {
			throw new Error(
				"Recording output is not a verified preservation of the committed source",
			);
		}
		options.sourceProof = proof.sourceProof;
	} else {
		const expectedKey = source.inventoryKey.replace(
			/inventory\.json$/,
			"mp4/0.mp4",
		);
		if (
			!source.mp4 ||
			((source.requiredAudio || request.requiredAudio) &&
				!proof.request.requiredAudio) ||
			request.artifact.kind !== "mp4" ||
			proof.outputKey !== expectedKey ||
			request.artifact.objectIdentity !== source.mp4.objectIdentity ||
			request.artifact.fileSize !== source.mp4.fileSize ||
			(source.mp4.duration !== undefined &&
				request.artifact.duration !== source.mp4.duration)
		) {
			throw new Error(
				"Verified recording does not match its retained MP4 source",
			);
		}
		options.sourceObjectIdentity = source.mp4.objectIdentity;
	}
	if (
		(source.requiredAudio || request.requiredAudio) &&
		!payload.metadata.audioCodec
	) {
		throw new Error("Verified recording is missing required audio");
	}
	return { request, options, metadata: payload.metadata, proof };
}

async function findRecordingAssets(
	video: typeof videos.$inferSelect,
	outputKey: string,
) {
	const [bucket] = await runWorkflowPromise(
		Storage.getAccessForVideo(decodeStorageVideo(video)),
	);
	const prefix = outputKey.replace(/\.mp4$/, "");
	const thumbnailKey = `${prefix}/screenshot.jpg`;
	const previewKey = `${prefix}/preview.gif`;
	const present = await Promise.all([
		runWorkflowPromise(bucket.headObject(thumbnailKey)).catch(() => null),
		runWorkflowPromise(bucket.headObject(previewKey)).catch(() => null),
	]);
	return {
		...(present[0]?.ContentLength ? { thumbnailKey } : {}),
		...(present[1]?.ContentLength ? { previewKey } : {}),
	};
}

export async function applyDesktopRecordingProgress(input: unknown): Promise<{
	handled: boolean;
	allowLegacyProcessing?: boolean;
	published?: boolean;
	status?: 200 | 400 | 409 | 503;
	recordingWorker?: RecordingWorkerAcknowledgement;
}> {
	const envelope = desktopRecordingProgressSchema
		.pick({ videoId: true, jobId: true, phase: true, progress: true })
		.extend({
			generation: z.string().min(1).optional(),
			attemptId: z.string().min(1).optional(),
		})
		.safeParse(input);
	if (
		!envelope.success ||
		Boolean(envelope.data.generation) !== Boolean(envelope.data.attemptId)
	) {
		return { handled: true, status: 400 };
	}
	const videoId = Video.VideoId.make(envelope.data.videoId);
	const job = await getProcessingState({ videoId });
	if (!job) {
		const workerPayload = desktopRecordingProgressSchema.safeParse(input);
		if (workerPayload.success && workerPayload.data.recordingWorker)
			return workerAcknowledgement(workerPayload.data, "superseded");
		return envelope.data.generation
			? { handled: true, status: 409 }
			: { handled: false };
	}
	if (!envelope.data.generation) {
		if (
			typeof input === "object" &&
			input !== null &&
			"recordingWorker" in input
		)
			return { handled: true, status: 400 };
		const [upload] = await db()
			.select({ rawFileKey: videoUploads.rawFileKey })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId));
		const recordingProof =
			typeof input === "object" &&
			input !== null &&
			("recordingVerification" in input || "manifestSha256" in input);
		const allowLegacyProcessing =
			(job.state === "verified" || job.errorCode === "output-replaced") &&
			!recordingProof &&
			Boolean(upload?.rawFileKey);
		return {
			handled: !allowLegacyProcessing,
			...(allowLegacyProcessing ? { allowLegacyProcessing: true } : {}),
			status: 200,
		};
	}
	const parsed = desktopRecordingProgressSchema.safeParse(input);
	if (!parsed.success) return { handled: true, status: 400 };
	const payload = parsed.data;
	if (payload.recordingWorker) {
		const disposition = workerDisposition(job, payload);
		if (disposition === "terminal")
			return workerAcknowledgement(payload, "accepted");
		if (disposition !== "advance" && disposition !== "repeat")
			return workerAcknowledgement(
				payload,
				disposition,
				job.remoteJobId ? { ownerJobId: job.remoteJobId } : {},
			);
		if (payload.phase !== "complete")
			return applyActiveRecordingProgress(payload);
	} else if (
		!isCurrentDesktopRecordingAttempt(job, payload) ||
		getDesktopRecordingWorkerCheckpoint(job)
	) {
		return { handled: true, status: 200 };
	}
	if (!isCurrentDesktopRecordingAttempt(job, payload)) {
		return { handled: true, status: 200 };
	}
	if (payload.phase !== "complete")
		return applyActiveRecordingProgress(payload);
	const completion = validateDesktopRecordingCompletion(job, payload);
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video || video.ownerId !== job.ownerId)
		return { handled: true, status: 409 };
	const receipt = await createVerifiedRecordingReceipt(
		video,
		completion.request,
		completion.metadata,
		true,
		completion.proof.objectIdentity,
		completion.options,
	);
	const outputKey = completion.proof.outputKey;
	const assets =
		job.source?.kind === "segments"
			? await findRecordingAssets(video, outputKey)
			: {};
	const published = await db().transaction(async (tx) => {
		const [current] = await tx
			.select()
			.from(videoProcessingJobs)
			.where(eq(videoProcessingJobs.videoId, videoId))
			.for("update");
		const currentJob = current ? parseDesktopRecordingJob(current) : null;
		if (
			!currentJob ||
			!isCurrentDesktopRecordingAttempt(currentJob, payload) ||
			(payload.recordingWorker
				? workerDisposition(currentJob, payload) !== "advance"
				: getDesktopRecordingWorkerCheckpoint(currentJob) !== null) ||
			!isDeepStrictEqual(currentJob.source, job.source) ||
			!isDeepStrictEqual(currentJob.verification, job.verification)
		)
			return false;
		const [currentVideo] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.for("update");
		if (
			!currentVideo ||
			currentVideo.ownerId !== job.ownerId ||
			currentVideo.bucket !== video.bucket ||
			currentVideo.storageIntegrationId !== video.storageIntegrationId ||
			!isDeepStrictEqual(currentVideo.source, video.source)
		)
			return false;
		const now = new Date();
		await tx
			.update(videos)
			.set({
				source: { type: "desktopMP4", outputKey, ...assets },
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.desktopRecordingUpload', JSON_EXTRACT(${JSON.stringify(receipt)}, '$'))`,
				duration: completion.metadata.duration,
				width: completion.metadata.width,
				height: completion.metadata.height,
				fps: Math.round(completion.metadata.fps),
			})
			.where(and(eq(videos.id, videoId), eq(videos.ownerId, job.ownerId)));
		await tx
			.update(videoProcessingJobs)
			.set({
				state: "verified",
				output: {
					...receipt,
					verifiedAt: now.toISOString(),
					...(payload.recordingWorker
						? { recordingWorker: workerCheckpoint(payload, now) }
						: {}),
				},
				leaseExpiresAt: null,
				errorCode: null,
				errorMessage: null,
				updatedAt: now,
			})
			.where(eq(videoProcessingJobs.videoId, videoId));
		await tx.delete(videoUploads).where(eq(videoUploads.videoId, videoId));
		return true;
	});
	if (!published) return { handled: true, status: 503 };
	await invalidateGoogleDriveStorageQuotaCache(
		video.storageIntegrationId,
	).catch(() => undefined);
	return {
		...(payload.recordingWorker
			? workerAcknowledgement(payload, "accepted")
			: { handled: true, status: 200 as const }),
		published: true,
	};
}
