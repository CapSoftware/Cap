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
	type DesktopRecordingJob,
	getProcessingState,
	markSourceBlocked,
	parseDesktopRecordingJob,
	scheduleRetry,
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
		return envelope.data.generation
			? { handled: true, status: 409 }
			: { handled: false };
	}
	if (!envelope.data.generation) {
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
	if (!isCurrentDesktopRecordingAttempt(job, payload)) {
		return { handled: true, status: 200 };
	}
	const fence = {
		videoId,
		generation: payload.generation,
		attemptId: payload.attemptId,
	};
	if (payload.phase === "error" || payload.phase === "cancelled") {
		const errorCode = payload.errorCode ?? "processing-unavailable";
		const errorMessage =
			payload.error ??
			payload.message ??
			"Recording processing was interrupted";
		if (
			["source-invalid", "source-missing", "source-changed"].includes(errorCode)
		) {
			await markSourceBlocked({ ...fence, errorCode, errorMessage });
		} else {
			await scheduleRetry({ ...fence, errorCode, errorMessage });
		}
		return { handled: true, status: 200 };
	}
	if (payload.phase !== "complete") {
		await db().transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(videoProcessingJobs)
				.where(eq(videoProcessingJobs.videoId, videoId))
				.for("update");
			if (
				!current ||
				!isCurrentDesktopRecordingAttempt(
					parseDesktopRecordingJob(current),
					payload,
				)
			)
				return;
			const now = new Date();
			await tx
				.update(videoProcessingJobs)
				.set({
					leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
					updatedAt: now,
				})
				.where(eq(videoProcessingJobs.videoId, videoId));
			await tx
				.update(videoUploads)
				.set({
					phase:
						payload.phase === "generating_thumbnail"
							? "generating_thumbnail"
							: "processing",
					processingProgress: Math.round(payload.progress),
					processingMessage:
						payload.message ?? "Verifying and processing recording...",
					processingError: null,
					updatedAt: now,
				})
				.where(eq(videoUploads.videoId, videoId));
		});
		return { handled: true, status: 200 };
	}
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
				output: { ...receipt, verifiedAt: now.toISOString() },
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
	return { handled: true, status: 200, published: true };
}
