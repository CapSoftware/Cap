import { db } from "@cap/database";
import { importedVideos, videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { S3Bucket, Video } from "@cap/web-domain";
import {
	and,
	asc,
	eq,
	isNotNull,
	isNull,
	like,
	lte,
	notLike,
	or,
	sql,
} from "drizzle-orm";
import { start } from "workflow/api";
import {
	getLoomImportRunState,
	LOOM_IMPORT_CONFIRMATION_MESSAGE,
	LoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";
import { setVideoProcessingError } from "@/lib/video-processing";
import { WORKFLOW_UPGRADE_ERROR_FRAGMENT } from "@/lib/workflow-recovery";
import { processVideoWorkflow } from "@/workflows/process-video";

export const VIDEO_PROCESSING_RECOVERY_BATCH_SIZE = 20;
export const LOOM_IMPORT_RECOVERY_BATCH_SIZE = 8;

const LOOM_IMPORT_RECOVERY_MIN_AGE_MS = 10 * 60 * 1000;
const LOOM_IMPORT_PENDING_MESSAGE = "Importing from Loom...";
const LOOM_IMPORT_RECOVERY_MESSAGE = "Restarting Loom import...";

const recoverableProcessingError = () =>
	or(
		like(videoUploads.processingError, `%${WORKFLOW_UPGRADE_ERROR_FRAGMENT}%`),
		like(videoUploads.processingError, "%Server is busy%"),
		like(videoUploads.processingError, "%SERVER_BUSY%"),
		like(
			videoUploads.processingError,
			"%processVideoOnMediaServer%exceeded max retries%",
		),
	);

export type FailedVideoProcessingRecoveryKind = "webMP4" | "loom";

export type FailedVideoProcessingRecoveryStatus =
	| "started"
	| "already-claimed"
	| "retry-scheduled"
	| "missing-source"
	| "reconciliation-required"
	| "failed";

export type FailedVideoProcessingRecoverySummary = {
	checked: number;
	statuses: Partial<Record<FailedVideoProcessingRecoveryStatus, number>>;
	results: Array<{
		videoId: Video.VideoId;
		kind: FailedVideoProcessingRecoveryKind;
		status: FailedVideoProcessingRecoveryStatus;
	}>;
};

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

async function recoverWebCandidate({
	videoId,
	userId,
	rawFileKey,
	bucketId,
}: {
	videoId: Video.VideoId;
	userId: string;
	rawFileKey: string;
	bucketId: S3Bucket.S3BucketId | null;
}): Promise<FailedVideoProcessingRecoveryStatus> {
	const claimResult = await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Processing video",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				eq(videoUploads.phase, "error"),
				eq(videoUploads.rawFileKey, rawFileKey),
				recoverableProcessingError(),
			),
		);

	if (getAffectedRows(claimResult) === 0) {
		return "already-claimed";
	}

	try {
		await start(processVideoWorkflow, [
			{
				videoId,
				userId,
				rawFileKey,
				bucketId,
			},
		]);
		return "started";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await setVideoProcessingError(
			videoId,
			"Processing recovery will retry automatically",
			new Error(
				`${WORKFLOW_UPGRADE_ERROR_FRAGMENT}; recovery start failed: ${message}`,
			),
		);
		return "retry-scheduled";
	}
}

async function recoverLoomCandidate({
	videoId,
	userId,
	bucketId,
	loomVideoId,
	rawFileKey: existingRawFileKey,
	phase,
	uploadUpdatedAt,
	receipt,
}: {
	videoId: Video.VideoId;
	userId: string;
	bucketId: S3Bucket.S3BucketId | null;
	loomVideoId: string;
	rawFileKey: string | null;
	phase: "uploading" | "processing" | "error";
	uploadUpdatedAt: Date;
	receipt: VideoMetadata["loomImportRun"];
}): Promise<FailedVideoProcessingRecoveryStatus> {
	const runState = await getLoomImportRunState(receipt);
	const receiptCondition = receipt
		? sql`EXISTS (SELECT 1 FROM ${videos} WHERE ${videos.id} = ${videoId} AND JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomImportRun.runId')) = ${receipt.runId})`
		: sql`EXISTS (SELECT 1 FROM ${videos} WHERE ${videos.id} = ${videoId} AND JSON_EXTRACT(${videos.metadata}, '$.loomImportRun') IS NULL)`;
	if (runState === "active") {
		await db()
			.update(videoUploads)
			.set({ updatedAt: new Date() })
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					eq(videoUploads.phase, phase),
					eq(videoUploads.updatedAt, uploadUpdatedAt),
					receiptCondition,
				),
			);
		return "already-claimed";
	}
	if (
		runState === "pending" ||
		runState === "unconfirmed" ||
		(phase === "processing" && !receipt)
	) {
		const result = await db()
			.update(videoUploads)
			.set({
				processingMessage: LOOM_IMPORT_CONFIRMATION_MESSAGE,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					eq(videoUploads.phase, phase),
					eq(videoUploads.updatedAt, uploadUpdatedAt),
					receiptCondition,
				),
			);
		return getAffectedRows(result) === 1
			? "reconciliation-required"
			: "already-claimed";
	}
	const rawFileKey =
		existingRawFileKey ?? `${userId}/${videoId}/raw-upload.mp4`;
	const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	const claimResult = await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: LOOM_IMPORT_RECOVERY_MESSAGE,
			processingError: null,
			rawFileKey,
			updatedAt: claimedAt,
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				eq(videoUploads.phase, phase),
				eq(videoUploads.updatedAt, uploadUpdatedAt),
				receiptCondition,
				...(phase === "error"
					? [
							eq(videoUploads.rawFileKey, rawFileKey),
							recoverableProcessingError(),
						]
					: phase === "processing"
						? [
								existingRawFileKey
									? eq(videoUploads.rawFileKey, existingRawFileKey)
									: isNull(videoUploads.rawFileKey),
							]
						: [
								isNull(videoUploads.rawFileKey),
								or(
									eq(
										videoUploads.processingMessage,
										LOOM_IMPORT_PENDING_MESSAGE,
									),
									eq(
										videoUploads.processingMessage,
										LOOM_IMPORT_CONFIRMATION_MESSAGE,
									),
								),
							]),
			),
		);

	if (getAffectedRows(claimResult) === 0) {
		return "already-claimed";
	}

	try {
		await startLoomImportWorkflow({
			videoId,
			userId,
			rawFileKey,
			bucketId,
			loomDownloadUrl: "",
			loomVideoId,
			reuseExistingRawUpload:
				phase !== "uploading" && existingRawFileKey !== null,
			importPriority: receipt?.importPriority,
		});
		return "started";
	} catch (error) {
		if (!(error instanceof LoomImportStartError) || !error.canRetry) {
			return "already-claimed";
		}
		const message = error instanceof Error ? error.message : String(error);
		if (phase !== "uploading") {
			await db()
				.update(videoUploads)
				.set({
					phase: "error",
					processingProgress: 0,
					processingMessage: "Loom import recovery will retry automatically",
					processingError: `import-loom-video: Server is busy; Loom import recovery start failed: ${message}`,
					rawFileKey,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(videoUploads.videoId, videoId),
						eq(videoUploads.phase, "processing"),
						eq(videoUploads.updatedAt, claimedAt),
						eq(videoUploads.rawFileKey, rawFileKey),
						eq(videoUploads.processingMessage, LOOM_IMPORT_RECOVERY_MESSAGE),
					),
				);
			return "retry-scheduled";
		}

		await db()
			.update(videoUploads)
			.set({
				phase: "uploading",
				processingProgress: 0,
				processingMessage: LOOM_IMPORT_PENDING_MESSAGE,
				processingError: `Loom import recovery start failed: ${message}`,
				rawFileKey: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					eq(videoUploads.phase, "processing"),
					eq(videoUploads.updatedAt, claimedAt),
					eq(videoUploads.rawFileKey, rawFileKey),
					eq(videoUploads.processingMessage, LOOM_IMPORT_RECOVERY_MESSAGE),
				),
			);
		return "retry-scheduled";
	}
}

export async function recoverFailedVideoProcessing({
	limit = VIDEO_PROCESSING_RECOVERY_BATCH_SIZE,
}: {
	limit?: number;
} = {}): Promise<FailedVideoProcessingRecoverySummary> {
	const staleLoomBefore = new Date(
		Date.now() - LOOM_IMPORT_RECOVERY_MIN_AGE_MS,
	);
	const selectStaleLoomCandidates = (phase: "uploading" | "processing") =>
		db()
			.select({
				videoId: videos.id,
				userId: videos.ownerId,
				bucketId: videos.bucket,
				loomVideoId: importedVideos.sourceId,
				rawFileKey: videoUploads.rawFileKey,
				uploadUpdatedAt: videoUploads.updatedAt,
				metadata: videos.metadata,
				phase: videoUploads.phase,
			})
			.from(videos)
			.innerJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.innerJoin(
				importedVideos,
				and(
					eq(videos.id, importedVideos.id),
					eq(videos.orgId, importedVideos.orgId),
					eq(importedVideos.source, "loom"),
				),
			)
			.where(
				and(
					eq(importedVideos.source, "loom"),
					eq(videoUploads.phase, phase),
					phase === "uploading"
						? or(
								and(
									isNull(videoUploads.rawFileKey),
									eq(
										videoUploads.processingMessage,
										LOOM_IMPORT_PENDING_MESSAGE,
									),
								),
								and(
									sql`JSON_EXTRACT(${videos.metadata}, '$.loomImportRun.runId') IS NOT NULL`,
									eq(
										videoUploads.processingMessage,
										LOOM_IMPORT_CONFIRMATION_MESSAGE,
									),
								),
							)
						: and(
								sql`JSON_EXTRACT(${videos.metadata}, '$.loomImportRun.runId') IS NOT NULL`,
								or(
									eq(
										videoUploads.processingMessage,
										LOOM_IMPORT_RECOVERY_MESSAGE,
									),
									eq(videoUploads.processingMessage, "Retrying Loom import..."),
									eq(
										videoUploads.processingMessage,
										"Processing Loom video...",
									),
									eq(
										videoUploads.processingMessage,
										LOOM_IMPORT_CONFIRMATION_MESSAGE,
									),
								),
							),
					lte(videoUploads.updatedAt, staleLoomBefore),
				),
			)
			.orderBy(asc(videoUploads.updatedAt))
			.limit(Math.min(limit, LOOM_IMPORT_RECOVERY_BATCH_SIZE));
	const pendingLoomCandidates = (
		await Promise.all([
			selectStaleLoomCandidates("uploading"),
			selectStaleLoomCandidates("processing"),
		])
	)
		.flat()
		.sort(
			(left, right) =>
				left.uploadUpdatedAt.getTime() - right.uploadUpdatedAt.getTime(),
		)
		.slice(0, Math.min(limit, LOOM_IMPORT_RECOVERY_BATCH_SIZE));

	const loomRecoveryBudget = Math.min(limit, LOOM_IMPORT_RECOVERY_BATCH_SIZE);
	const startupCountWithFailedImport = Math.min(
		pendingLoomCandidates.length,
		Math.max(0, loomRecoveryBudget - 1),
	);
	const failedLoomUploads = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			orgId: videos.orgId,
			bucketId: videos.bucket,
			rawFileKey: videoUploads.rawFileKey,
			uploadUpdatedAt: videoUploads.updatedAt,
			metadata: videos.metadata,
		})
		.from(videos)
		.innerJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				eq(videoUploads.phase, "error"),
				isNotNull(videoUploads.rawFileKey),
				like(videoUploads.processingError, "%import-loom-video%"),
				recoverableProcessingError(),
			),
		)
		.orderBy(asc(videoUploads.updatedAt))
		.limit(Math.max(0, loomRecoveryBudget - startupCountWithFailedImport));

	const failedLoomCandidates = (
		await Promise.all(
			failedLoomUploads.map(async (candidate) => {
				const [importedVideo] = await db()
					.select({ loomVideoId: importedVideos.sourceId })
					.from(importedVideos)
					.where(
						and(
							eq(importedVideos.orgId, candidate.orgId),
							eq(importedVideos.source, "loom"),
							eq(importedVideos.id, candidate.videoId),
						),
					)
					.limit(1);
				return importedVideo
					? { ...candidate, loomVideoId: importedVideo.loomVideoId }
					: null;
			}),
		)
	).filter((candidate) => candidate !== null);

	const loomCandidates = [
		...pendingLoomCandidates
			.slice(0, Math.max(0, loomRecoveryBudget - failedLoomCandidates.length))
			.map((candidate) => ({
				...candidate,
				phase:
					candidate.phase === "processing"
						? ("processing" as const)
						: ("uploading" as const),
			})),
		...failedLoomCandidates.map((candidate) => ({
			...candidate,
			phase: "error" as const,
		})),
	];

	const webCandidates = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			bucketId: videos.bucket,
			rawFileKey: videoUploads.rawFileKey,
		})
		.from(videos)
		.innerJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.type')) = 'webMP4'`,
				eq(videoUploads.phase, "error"),
				isNotNull(videoUploads.rawFileKey),
				notLike(videoUploads.processingError, "%import-loom-video%"),
				recoverableProcessingError(),
			),
		)
		.orderBy(asc(videoUploads.updatedAt))
		.limit(Math.max(0, limit - loomCandidates.length));

	const candidates = [
		...loomCandidates.map((candidate) => ({
			...candidate,
			kind: "loom" as const,
		})),
		...webCandidates.map((candidate) => ({
			...candidate,
			kind: "webMP4" as const,
		})),
	];

	const summary: FailedVideoProcessingRecoverySummary = {
		checked: candidates.length,
		statuses: {},
		results: [],
	};

	for (const candidate of candidates) {
		let status: FailedVideoProcessingRecoveryStatus;
		if (candidate.kind === "loom") {
			try {
				status = await recoverLoomCandidate({
					videoId: candidate.videoId,
					userId: candidate.userId,
					bucketId: candidate.bucketId,
					loomVideoId: candidate.loomVideoId,
					rawFileKey: candidate.rawFileKey,
					phase: candidate.phase,
					uploadUpdatedAt: candidate.uploadUpdatedAt,
					receipt: candidate.metadata?.loomImportRun,
				});
			} catch (error) {
				status = "failed";
				console.error(
					`[video-processing-recovery] Failed to recover ${candidate.videoId}:`,
					error,
				);
			}
		} else if (!candidate.rawFileKey) {
			status = "missing-source";
		} else {
			try {
				status = await recoverWebCandidate({
					videoId: candidate.videoId,
					userId: candidate.userId,
					rawFileKey: candidate.rawFileKey,
					bucketId: candidate.bucketId,
				});
			} catch (error) {
				status = "failed";
				console.error(
					`[video-processing-recovery] Failed to recover ${candidate.videoId}:`,
					error,
				);
			}
		}

		summary.statuses[status] = (summary.statuses[status] ?? 0) + 1;
		summary.results.push({
			videoId: candidate.videoId,
			kind: candidate.kind,
			status,
		});
	}

	return summary;
}
