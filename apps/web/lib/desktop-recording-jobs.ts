import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import {
	and,
	asc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	or,
} from "drizzle-orm";
import { z } from "zod";
import type { DesktopRecordingSource } from "@/lib/desktop-recording-source";
import {
	type DesktopRecordingSourceCheckpoint,
	desktopRecordingSourceCheckpointSchema,
} from "@/lib/desktop-recording-source-checkpoint";
import {
	type RecordingVerification,
	recordingVerificationSchema,
} from "@/lib/desktop-recording-verification";

export const DESKTOP_RECORDING_LEASE_MS = 5 * 60 * 1_000;
export const DESKTOP_RECORDING_SOURCE_RETRY_MS = 60 * 60 * 1_000;
export const DESKTOP_RECORDING_OUTPUT_REPLACED = "output-replaced";
export const DESKTOP_RECORDING_DELETING = "video-deleting";

const sourceSchema = z.object({
	version: z.literal(1),
	kind: z.enum(["segments", "mp4"]),
	manifestSha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	inventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
	inventoryKey: z.string().min(1),
	requiredAudio: z.boolean(),
	mp4: z
		.object({
			fileSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			duration: z.number().finite().positive().optional(),
			objectIdentity: z.string().min(1),
		})
		.optional(),
});

type StoredJob = typeof videoProcessingJobs.$inferSelect;

export type DesktopRecordingJob = Omit<StoredJob, "source" | "verification"> & {
	source: DesktopRecordingSource | null;
	verification: RecordingVerification | null;
};

export type DesktopRecordingAttempt = DesktopRecordingJob & {
	attemptId: string;
};

export type DesktopRecordingAttemptFence = {
	videoId: Video.VideoId;
	generation: string;
	attemptId: string;
};

export class SourceCommitPendingError extends Error {
	readonly code = "source-commit-pending";

	constructor() {
		super(
			"Recording source is still being secured. Processing will continue automatically.",
		);
		this.name = "SourceCommitPendingError";
	}
}

export class DesktopRecordingSourceBlockedError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "DesktopRecordingSourceBlockedError";
	}
}

export function parseDesktopRecordingJob(row: StoredJob): DesktopRecordingJob {
	return {
		...row,
		source: row.source === null ? null : sourceSchema.parse(row.source),
		verification:
			row.verification === null
				? null
				: recordingVerificationSchema.parse(row.verification),
	};
}

export function getDesktopRecordingRetryDelay(attemptCount: number) {
	return Math.min(
		15_000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 8),
		3_600_000,
	);
}

export function isDesktopRecordingJobRecoverable(
	job: DesktopRecordingJob,
	now: Date,
) {
	if (job.state === "verified") return false;
	if (job.errorCode === DESKTOP_RECORDING_OUTPUT_REPLACED) return false;
	if (job.errorCode === DESKTOP_RECORDING_DELETING) return false;
	if (job.state === "source-blocked" && job.source) return false;
	if (job.leaseExpiresAt && job.leaseExpiresAt > now) return false;
	return job.nextRetryAt <= now;
}

function sameArtifact(
	verification: RecordingVerification,
	job: DesktopRecordingJob,
) {
	const previous = job.verification?.artifact;
	const incoming = verification.artifact;
	if (incoming.kind === "segments") {
		return (
			job.source?.kind !== "mp4" &&
			(job.source?.manifestSha256 ??
				job.manifestSha256 ??
				(previous?.kind === "segments" ? previous.manifestSha256 : null)) ===
				incoming.manifestSha256
		);
	}
	const mp4 = job.source?.mp4 ?? (previous?.kind === "mp4" ? previous : null);
	return (
		job.source?.kind !== "segments" &&
		mp4?.objectIdentity === incoming.objectIdentity &&
		mp4.fileSize === incoming.fileSize &&
		(mp4.duration === undefined || mp4.duration === incoming.duration)
	);
}

function newJob({
	videoId,
	userId,
	verification,
	now,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
	verification?: RecordingVerification;
	now: Date;
}): DesktopRecordingJob {
	return {
		videoId,
		ownerId: userId,
		generation: randomUUID(),
		manifestSha256:
			verification?.artifact.kind === "segments"
				? verification.artifact.manifestSha256
				: null,
		state: "committing",
		attemptId: null,
		attemptCount: 0,
		leaseExpiresAt: null,
		nextRetryAt: now,
		workflowRunId: null,
		remoteJobId: null,
		source: null,
		verification: verification ?? null,
		output: null,
		errorCode: null,
		errorMessage: null,
		createdAt: now,
		updatedAt: now,
	};
}

export async function ensureSegmentProcessingJob({
	videoId,
	userId,
	verification,
	now = new Date(),
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
	verification?: RecordingVerification;
	now?: Date;
}): Promise<{ job: DesktopRecordingJob; created: boolean }> {
	const candidate = newJob({ videoId, userId, verification, now });
	return db().transaction(async (tx) => {
		// Locking a missing job before inserting it deadlocks concurrent completion requests under InnoDB gap locking.
		await tx
			.insert(videoProcessingJobs)
			.values(candidate)
			.onDuplicateKeyUpdate({ set: { videoId } });
		const [stored] = await tx
			.select()
			.from(videoProcessingJobs)
			.where(eq(videoProcessingJobs.videoId, videoId))
			.for("update");
		const [video] = await tx
			.select({ ownerId: videos.ownerId, source: videos.source })
			.from(videos)
			.where(eq(videos.id, videoId))
			.for("update");
		if (!video || video.ownerId !== userId) {
			throw new Error("Recording does not exist");
		}
		if (
			video.source.type !== "desktopSegments" &&
			video.source.type !== "desktopMP4"
		) {
			throw new Error("Recording is not a desktop upload");
		}
		if (!stored) throw new Error("Recording job could not be created");
		let job = parseDesktopRecordingJob(stored);
		const created = job.generation === candidate.generation;
		if (job.errorCode === DESKTOP_RECORDING_DELETING) {
			throw new DesktopRecordingSourceBlockedError(
				DESKTOP_RECORDING_DELETING,
				"This recording is being deleted and will not be processed again.",
			);
		}
		if (job.errorCode === DESKTOP_RECORDING_OUTPUT_REPLACED) {
			throw new DesktopRecordingSourceBlockedError(
				DESKTOP_RECORDING_OUTPUT_REPLACED,
				"This recording was intentionally edited or replaced. Its original source is retained and will not replace the current video.",
			);
		}
		const replacesArtifact =
			verification !== undefined &&
			(job.source !== null || job.verification !== null) &&
			!sameArtifact(verification, job);
		if (created || replacesArtifact) {
			if (replacesArtifact) {
				job = candidate;
				await tx
					.update(videoProcessingJobs)
					.set(job)
					.where(eq(videoProcessingJobs.videoId, videoId));
			}
			const upload = {
				phase: "processing" as const,
				processingProgress: 0,
				processingMessage: "Securing recording source...",
				processingError: null,
				updatedAt: now,
			};
			await tx
				.insert(videoUploads)
				.values({ videoId, ...upload })
				.onDuplicateKeyUpdate({ set: upload });
			return { job, created: true };
		}
		if (job.ownerId !== userId) throw new Error("Recording owner changed");
		if (verification) {
			const needsReverification =
				job.state === "verified" &&
				((verification.artifact.kind === "mp4" && !job.verification) ||
					(verification.requiredAudio && !job.verification?.requiredAudio));
			const mergedVerification = {
				...verification,
				requiredAudio:
					verification.requiredAudio ||
					job.verification?.requiredAudio === true,
			};
			job = { ...job, verification: mergedVerification, updatedAt: now };
			await tx
				.update(videoProcessingJobs)
				.set({ verification: mergedVerification, updatedAt: now })
				.where(eq(videoProcessingJobs.videoId, videoId));
			if (needsReverification) {
				job = {
					...job,
					state: "retry",
					leaseExpiresAt: null,
					nextRetryAt: now,
					workflowRunId: null,
				};
				await tx
					.update(videoProcessingJobs)
					.set(job)
					.where(eq(videoProcessingJobs.videoId, videoId));
			}
		}
		if (job.state === "source-blocked" && !job.source) {
			job = {
				...job,
				state: "committing",
				output: null,
				leaseExpiresAt: null,
				nextRetryAt: now,
				workflowRunId: null,
				errorCode: null,
				errorMessage: null,
				updatedAt: now,
			};
			await tx
				.update(videoProcessingJobs)
				.set(job)
				.where(eq(videoProcessingJobs.videoId, videoId));
		}
		return { job, created: false };
	});
}

export async function getProcessingState({
	videoId,
	generation,
}: {
	videoId: Video.VideoId;
	generation?: string;
}): Promise<DesktopRecordingJob | null> {
	const [row] = await db()
		.select()
		.from(videoProcessingJobs)
		.where(
			and(
				eq(videoProcessingJobs.videoId, videoId),
				generation ? eq(videoProcessingJobs.generation, generation) : undefined,
			),
		)
		.limit(1);
	return row ? parseDesktopRecordingJob(row) : null;
}

export async function claimProcessingAttempt({
	videoId,
	generation,
	now = new Date(),
}: {
	videoId: Video.VideoId;
	generation: string;
	now?: Date;
}): Promise<DesktopRecordingAttempt | null> {
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(videoProcessingJobs)
			.where(
				and(
					eq(videoProcessingJobs.videoId, videoId),
					eq(videoProcessingJobs.generation, generation),
				),
			)
			.for("update");
		if (!row) return null;
		const job = parseDesktopRecordingJob(row);
		if (!isDesktopRecordingJobRecoverable(job, now)) return null;
		const attempt: DesktopRecordingAttempt = {
			...job,
			state: job.source ? "processing" : "committing",
			attemptId: randomUUID(),
			attemptCount: job.attemptCount + 1,
			leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
			remoteJobId: null,
			errorCode: null,
			errorMessage: null,
			updatedAt: now,
		};
		await tx
			.update(videoProcessingJobs)
			.set(attempt)
			.where(eq(videoProcessingJobs.videoId, videoId));
		const upload = {
			phase: "processing" as const,
			processingProgress: 0,
			processingMessage: job.source
				? "Verifying and processing recording..."
				: "Securing recording source...",
			processingError: null,
			updatedAt: now,
		};
		await tx
			.insert(videoUploads)
			.values({ videoId, ...upload })
			.onDuplicateKeyUpdate({ set: upload });
		return attempt;
	});
}

function attemptCondition(fence: DesktopRecordingAttemptFence) {
	return and(
		eq(videoProcessingJobs.videoId, fence.videoId),
		eq(videoProcessingJobs.generation, fence.generation),
		eq(videoProcessingJobs.attemptId, fence.attemptId),
		inArray(videoProcessingJobs.state, ["committing", "queued", "processing"]),
	);
}

function affectedRows(result: unknown) {
	const item = Array.isArray(result) ? result[0] : result;
	if (!item || typeof item !== "object" || !("affectedRows" in item)) return 0;
	return typeof item.affectedRows === "number" ? item.affectedRows : 0;
}

export async function initializeSourceCommitCheckpoint(
	fence: DesktopRecordingAttemptFence,
): Promise<DesktopRecordingSourceCheckpoint | null> {
	const now = new Date();
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(videoProcessingJobs)
			.where(and(attemptCondition(fence), isNull(videoProcessingJobs.source)))
			.for("update");
		if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return null;
		if (row.output !== null) {
			const checkpoint = desktopRecordingSourceCheckpointSchema.parse(
				row.output,
			);
			if (checkpoint.generation !== fence.generation) return null;
			return checkpoint;
		}
		const checkpoint: DesktopRecordingSourceCheckpoint = {
			kind: "desktop-recording-source-commit",
			version: 1,
			generation: fence.generation,
			snapshotId: randomUUID(),
			revision: 0,
			phase: "plan",
			cursor: 0,
			planRoots: [],
			receiptRoots: [],
		};
		await tx
			.update(videoProcessingJobs)
			.set({ output: checkpoint, updatedAt: now })
			.where(attemptCondition(fence));
		return checkpoint;
	});
}

export async function persistSourceCommitCheckpoint(
	fence: DesktopRecordingAttemptFence,
	checkpoint: DesktopRecordingSourceCheckpoint,
): Promise<boolean> {
	const parsed = desktopRecordingSourceCheckpointSchema.parse(checkpoint);
	if (parsed.generation !== fence.generation) return false;
	const now = new Date();
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(videoProcessingJobs)
			.where(and(attemptCondition(fence), isNull(videoProcessingJobs.source)))
			.for("update");
		if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return false;
		const previous = desktopRecordingSourceCheckpointSchema.parse(row.output);
		if (
			previous.generation !== parsed.generation ||
			previous.snapshotId !== parsed.snapshotId ||
			previous.revision + 1 !== parsed.revision
		)
			return false;
		await tx
			.update(videoProcessingJobs)
			.set({
				output: parsed,
				leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
				updatedAt: now,
			})
			.where(attemptCondition(fence));
		return true;
	});
}

export async function persistCommittedSource(
	fence: DesktopRecordingAttemptFence,
	source: DesktopRecordingSource,
): Promise<boolean> {
	let parsed = sourceSchema.parse(source);
	const now = new Date();
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(videoProcessingJobs)
			.where(attemptCondition(fence))
			.for("update");
		if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return false;
		const current = parseDesktopRecordingJob(row);
		if (current.source) {
			return current.source.inventorySha256 === parsed.inventorySha256;
		}
		const verification = current.verification;
		if (
			verification &&
			(!sameArtifact(verification, { ...current, source: parsed }) ||
				(parsed.kind === "segments" &&
					verification.requiredAudio &&
					!parsed.requiredAudio))
		) {
			await tx
				.update(videoProcessingJobs)
				.set({
					state: "retry",
					output: null,
					leaseExpiresAt: null,
					nextRetryAt: new Date(
						now.getTime() + getDesktopRecordingRetryDelay(1),
					),
					errorCode: "source-intent-changed",
					errorMessage:
						"The completed upload changed while its source was being secured. Retrying its snapshot.",
					updatedAt: now,
				})
				.where(attemptCondition(fence));
			return false;
		}
		if (
			parsed.kind === "mp4" &&
			parsed.mp4 &&
			verification?.artifact.kind === "mp4"
		) {
			parsed = {
				...parsed,
				requiredAudio: parsed.requiredAudio || verification.requiredAudio,
				mp4: { ...parsed.mp4, duration: verification.artifact.duration },
			};
		}
		await tx
			.update(videoProcessingJobs)
			.set({
				source: parsed,
				output: null,
				manifestSha256: parsed.manifestSha256 ?? null,
				state: "processing",
				leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
				updatedAt: now,
			})
			.where(attemptCondition(fence));
		return true;
	});
}

export async function attachRemoteJob({
	remoteJobId,
	...fence
}: DesktopRecordingAttemptFence & { remoteJobId: string }): Promise<boolean> {
	const now = new Date();
	const result = await db()
		.update(videoProcessingJobs)
		.set({ remoteJobId, updatedAt: now })
		.where(
			and(
				attemptCondition(fence),
				gt(videoProcessingJobs.leaseExpiresAt, now),
				or(
					isNull(videoProcessingJobs.remoteJobId),
					eq(videoProcessingJobs.remoteJobId, remoteJobId),
				),
			),
		);
	return affectedRows(result) > 0;
}

export async function heartbeatAttempt({
	now = new Date(),
	...fence
}: DesktopRecordingAttemptFence & { now?: Date }): Promise<boolean> {
	const result = await db()
		.update(videoProcessingJobs)
		.set({
			leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
			updatedAt: now,
		})
		.where(
			and(attemptCondition(fence), gt(videoProcessingJobs.leaseExpiresAt, now)),
		);
	return affectedRows(result) > 0;
}

export async function scheduleRetry({
	errorCode,
	errorMessage,
	now = new Date(),
	nextRetryAt,
	...fence
}: DesktopRecordingAttemptFence & {
	errorCode: string;
	errorMessage: string;
	now?: Date;
	nextRetryAt?: Date;
}): Promise<boolean> {
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select({ attemptCount: videoProcessingJobs.attemptCount })
			.from(videoProcessingJobs)
			.where(attemptCondition(fence))
			.for("update");
		if (!row) return false;
		await tx
			.update(videoProcessingJobs)
			.set({
				state: "retry",
				leaseExpiresAt: null,
				nextRetryAt:
					nextRetryAt ??
					new Date(
						now.getTime() + getDesktopRecordingRetryDelay(row.attemptCount),
					),
				errorCode,
				errorMessage,
				updatedAt: now,
			})
			.where(attemptCondition(fence));
		await tx
			.update(videoUploads)
			.set({
				phase: "processing",
				processingMessage: "Processing interrupted. Retrying automatically...",
				processingError: null,
				updatedAt: now,
			})
			.where(eq(videoUploads.videoId, fence.videoId));
		return true;
	});
}

export async function markSourceBlocked({
	errorCode,
	errorMessage,
	now = new Date(),
	...fence
}: DesktopRecordingAttemptFence & {
	errorCode: string;
	errorMessage: string;
	now?: Date;
}): Promise<boolean> {
	return db().transaction(async (tx) => {
		const result = await tx
			.update(videoProcessingJobs)
			.set({
				state: "source-blocked",
				leaseExpiresAt: null,
				nextRetryAt: new Date(
					now.getTime() + DESKTOP_RECORDING_SOURCE_RETRY_MS,
				),
				errorCode,
				errorMessage,
				updatedAt: now,
			})
			.where(attemptCondition(fence));
		if (affectedRows(result) === 0) return false;
		await tx
			.update(videoUploads)
			.set({
				phase: "error",
				processingMessage:
					"Waiting for complete recording source. Uploaded files are retained.",
				processingError: `${errorCode}: ${errorMessage}`,
				updatedAt: now,
			})
			.where(eq(videoUploads.videoId, fence.videoId));
		return true;
	});
}

export async function attachWorkflowRun({
	videoId,
	generation,
	workflowRunId,
}: {
	videoId: Video.VideoId;
	generation: string;
	workflowRunId: string;
}): Promise<void> {
	await db()
		.update(videoProcessingJobs)
		.set({ workflowRunId })
		.where(
			and(
				eq(videoProcessingJobs.videoId, videoId),
				eq(videoProcessingJobs.generation, generation),
			),
		);
}

export async function recordWorkflowDispatchFailure({
	videoId,
	generation,
	errorMessage,
	now = new Date(),
}: {
	videoId: Video.VideoId;
	generation: string;
	errorMessage: string;
	now?: Date;
}): Promise<void> {
	await db()
		.update(videoProcessingJobs)
		.set({
			workflowRunId: null,
			nextRetryAt: new Date(now.getTime() + getDesktopRecordingRetryDelay(1)),
			errorCode: "workflow-dispatch-failed",
			errorMessage,
			updatedAt: now,
		})
		.where(
			and(
				eq(videoProcessingJobs.videoId, videoId),
				eq(videoProcessingJobs.generation, generation),
				inArray(videoProcessingJobs.state, ["committing", "queued", "retry"]),
				or(
					isNull(videoProcessingJobs.leaseExpiresAt),
					lte(videoProcessingJobs.leaseExpiresAt, now),
				),
			),
		);
}

export async function deferWithoutMediaServer(
	fence: DesktopRecordingAttemptFence,
): Promise<boolean> {
	const now = new Date();
	return db().transaction(async (tx) => {
		const result = await tx
			.update(videoProcessingJobs)
			.set({
				state: "queued",
				leaseExpiresAt: null,
				nextRetryAt: new Date(
					now.getTime() + 24 * DESKTOP_RECORDING_SOURCE_RETRY_MS,
				),
				errorCode: "media-server-unconfigured",
				errorMessage:
					"Source is retained; full output verification requires a media server.",
				updatedAt: now,
			})
			.where(attemptCondition(fence));
		if (affectedRows(result) === 0) return false;
		await tx
			.delete(videoUploads)
			.where(eq(videoUploads.videoId, fence.videoId));
		return true;
	});
}

export async function retireDesktopRecordingJobForOutputReplacement(
	tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
	{
		videoId,
		userId,
		now = new Date(),
	}: { videoId: Video.VideoId; userId: User.UserId; now?: Date },
): Promise<void> {
	const retired = {
		generation: randomUUID(),
		state: "source-blocked" as const,
		attemptId: null,
		leaseExpiresAt: null,
		nextRetryAt: now,
		workflowRunId: null,
		remoteJobId: null,
		errorCode: DESKTOP_RECORDING_OUTPUT_REPLACED,
		errorMessage:
			"Original source retained after an intentional video edit or replacement.",
		updatedAt: now,
	};
	// MP4 outputs can be original-source snapshots; preserve source and output references until whole-video deletion.
	await tx
		.insert(videoProcessingJobs)
		.values({ ...newJob({ videoId, userId, now }), ...retired })
		.onDuplicateKeyUpdate({ set: retired });
}

export async function listRecoverableSegmentJobs({
	now = new Date(),
	limit = 20,
}: {
	now?: Date;
	limit?: number;
} = {}): Promise<DesktopRecordingJob[]> {
	const batchSize = Math.max(1, Math.min(limit, 100));
	const pending = await db()
		.select(getTableColumns(videoProcessingJobs))
		.from(videoProcessingJobs)
		.innerJoin(videos, eq(videos.id, videoProcessingJobs.videoId))
		.where(
			and(
				inArray(videoProcessingJobs.state, [
					"committing",
					"queued",
					"retry",
					"source-blocked",
				]),
				or(
					ne(videoProcessingJobs.state, "source-blocked"),
					isNull(videoProcessingJobs.source),
				),
				or(
					isNull(videoProcessingJobs.errorCode),
					and(
						ne(
							videoProcessingJobs.errorCode,
							DESKTOP_RECORDING_OUTPUT_REPLACED,
						),
						ne(videoProcessingJobs.errorCode, DESKTOP_RECORDING_DELETING),
					),
				),
				lte(videoProcessingJobs.nextRetryAt, now),
				or(
					isNull(videoProcessingJobs.leaseExpiresAt),
					lte(videoProcessingJobs.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(
			asc(videoProcessingJobs.nextRetryAt),
			asc(videoProcessingJobs.videoId),
		)
		.limit(batchSize);
	const expired = await db()
		.select(getTableColumns(videoProcessingJobs))
		.from(videoProcessingJobs)
		.innerJoin(videos, eq(videos.id, videoProcessingJobs.videoId))
		.where(
			and(
				eq(videoProcessingJobs.state, "processing"),
				lte(videoProcessingJobs.leaseExpiresAt, now),
			),
		)
		.orderBy(
			asc(videoProcessingJobs.leaseExpiresAt),
			asc(videoProcessingJobs.videoId),
		)
		.limit(batchSize);
	return [...pending, ...expired]
		.map(parseDesktopRecordingJob)
		.filter((job) => isDesktopRecordingJobRecoverable(job, now))
		.sort((left, right) => {
			const leftDue = left.leaseExpiresAt ?? left.nextRetryAt;
			const rightDue = right.leaseExpiresAt ?? right.nextRetryAt;
			return (
				leftDue.getTime() - rightDue.getTime() ||
				left.videoId.localeCompare(right.videoId)
			);
		})
		.slice(0, batchSize);
}
