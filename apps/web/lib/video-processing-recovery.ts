import { db } from "@cap/database";
import { importedVideos, videos, videoUploads } from "@cap/database/schema";
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
import { setVideoProcessingError } from "@/lib/video-processing";
import { WORKFLOW_UPGRADE_ERROR_FRAGMENT } from "@/lib/workflow-recovery";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";
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
}: {
	videoId: Video.VideoId;
	userId: string;
	bucketId: S3Bucket.S3BucketId | null;
	loomVideoId: string;
	rawFileKey: string | null;
	phase: "uploading" | "error";
}): Promise<FailedVideoProcessingRecoveryStatus> {
	const rawFileKey =
		existingRawFileKey ?? `${userId}/${videoId}/raw-upload.mp4`;
	const claimResult = await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: LOOM_IMPORT_RECOVERY_MESSAGE,
			processingError: null,
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				eq(videoUploads.phase, phase),
				...(phase === "error"
					? [
							eq(videoUploads.rawFileKey, rawFileKey),
							recoverableProcessingError(),
						]
					: [
							isNull(videoUploads.rawFileKey),
							eq(videoUploads.processingMessage, LOOM_IMPORT_PENDING_MESSAGE),
						]),
			),
		);

	if (getAffectedRows(claimResult) === 0) {
		return "already-claimed";
	}

	try {
		await start(importLoomVideoWorkflow, [
			{
				videoId,
				userId,
				rawFileKey,
				bucketId,
				loomDownloadUrl: "",
				loomVideoId,
				reuseExistingRawUpload: phase === "error",
			},
		]);
		return "started";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (phase === "error") {
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
	const pendingLoomCandidates = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			bucketId: videos.bucket,
			loomVideoId: importedVideos.sourceId,
			rawFileKey: videoUploads.rawFileKey,
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
				eq(videoUploads.phase, "uploading"),
				isNull(videoUploads.rawFileKey),
				eq(videoUploads.processingMessage, LOOM_IMPORT_PENDING_MESSAGE),
				lte(videoUploads.updatedAt, staleLoomBefore),
			),
		)
		.orderBy(asc(videoUploads.updatedAt))
		.limit(Math.min(limit, LOOM_IMPORT_RECOVERY_BATCH_SIZE));

	const failedLoomUploads = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			orgId: videos.orgId,
			bucketId: videos.bucket,
			rawFileKey: videoUploads.rawFileKey,
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
		.limit(
			Math.max(
				0,
				Math.min(limit, LOOM_IMPORT_RECOVERY_BATCH_SIZE) -
					pendingLoomCandidates.length,
			),
		);

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
		...pendingLoomCandidates.map((candidate) => ({
			...candidate,
			phase: "uploading" as const,
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
