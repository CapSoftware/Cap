import { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
	DesktopRecordingSourceBlockedError,
	listRecoverableSegmentJobs,
	SourceCommitPendingError,
} from "@/lib/desktop-recording-jobs";
import {
	type DesktopSegmentsFinalizationStatus,
	queueDesktopSegmentsFinalization,
} from "@/lib/desktop-segments-finalization";
import { getDesktopSegmentsManifestSignature } from "@/lib/desktop-segments-recovery-marker";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const DESKTOP_SEGMENTS_RECOVERY_MIN_AGE_MS = 60 * 60 * 1_000;
export const DESKTOP_SEGMENTS_RECOVERY_BATCH_SIZE = 20;

const RECOVERABLE_UPLOAD_PHASES = [
	"uploading",
	"processing",
	"generating_thumbnail",
	"error",
] as const;

type DesktopSegmentsRecoveryResult =
	| {
			status: DesktopSegmentsFinalizationStatus;
			manifestCompleted: false;
			videoSegments: number;
			audioSegments: number;
	  }
	| { status: "already-finalized" }
	| { status: "not-found" }
	| { status: "not-segmented" }
	| { status: "missing-manifest" }
	| { status: "invalid-manifest"; error: string }
	| { status: "no-video-segments" }
	| { status: "manifest-changed" }
	| { status: "source-incomplete" }
	| { status: "source-committing" };

export type StaleDesktopSegmentsRecoveryStatus =
	| DesktopSegmentsRecoveryResult["status"]
	| "failed";

export type StaleDesktopSegmentsRecoverySummary = {
	checked: number;
	statuses: Partial<Record<StaleDesktopSegmentsRecoveryStatus, number>>;
	results: Array<{
		videoId: Video.VideoId;
		status: StaleDesktopSegmentsRecoveryStatus;
	}>;
};

type LoadedDesktopSegmentsManifest =
	| {
			status: "loaded";
			video: typeof videos.$inferSelect;
			manifest: Video.SegmentManifestType;
	  }
	| { status: "already-finalized" }
	| { status: "not-found" }
	| { status: "not-segmented" }
	| { status: "missing-manifest" }
	| { status: "invalid-manifest"; error: string };

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function loadDesktopSegmentsManifest({
	videoId,
	userId,
}: {
	videoId: Video.VideoId;
	userId?: User.UserId;
}): Promise<LoadedDesktopSegmentsManifest> {
	const [video] = await db()
		.select()
		.from(videos)
		.where(
			and(
				eq(videos.id, videoId),
				userId ? eq(videos.ownerId, userId) : undefined,
			),
		)
		.limit(1);
	if (!video) return { status: "not-found" };
	if (video.source.type === "desktopMP4")
		return { status: "already-finalized" };
	if (video.source.type !== "desktopSegments")
		return { status: "not-segmented" };
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	const source = new Video.SegmentsSource({ videoId, ownerId: video.ownerId });
	const content = await bucket
		.getObject(source.getManifestKey())
		.pipe(runPromise);
	const json = Option.getOrNull(content);
	if (!json) return { status: "missing-manifest" };
	try {
		const manifest = await Schema.decodeUnknown(Video.SegmentManifest)(
			JSON.parse(json),
		)
			.pipe(Effect.mapError(getErrorMessage))
			.pipe(runPromise);
		return { status: "loaded", video, manifest };
	} catch (error) {
		return { status: "invalid-manifest", error: getErrorMessage(error) };
	}
}

export async function completeDesktopSegmentsManifestAndQueue({
	videoId,
	userId,
	expectedManifestSignature,
}: {
	videoId: Video.VideoId;
	userId?: User.UserId;
	expectedManifestSignature?: string;
}): Promise<DesktopSegmentsRecoveryResult> {
	const loaded = await loadDesktopSegmentsManifest({ videoId, userId });
	if (loaded.status !== "loaded") return loaded;
	if (
		!loaded.manifest.video_init_uploaded ||
		loaded.manifest.video_segments.length === 0
	) {
		return { status: "no-video-segments" };
	}
	if (
		expectedManifestSignature &&
		getDesktopSegmentsManifestSignature(loaded.manifest) !==
			expectedManifestSignature
	) {
		return { status: "manifest-changed" };
	}
	if (!loaded.manifest.is_complete) return { status: "source-incomplete" };
	try {
		const status = await queueDesktopSegmentsFinalization({
			videoId,
			userId: loaded.video.ownerId,
		});
		return {
			status,
			manifestCompleted: false,
			videoSegments: loaded.manifest.video_segments.length,
			audioSegments: loaded.manifest.audio_segments.length,
		};
	} catch (error) {
		if (error instanceof SourceCommitPendingError)
			return { status: "source-committing" };
		if (error instanceof DesktopRecordingSourceBlockedError)
			return { status: "source-incomplete" };
		throw error;
	}
}

async function recoverRecording({
	videoId,
	userId,
	verification,
}: Parameters<
	typeof queueDesktopSegmentsFinalization
>[0]): Promise<StaleDesktopSegmentsRecoveryStatus> {
	try {
		return await queueDesktopSegmentsFinalization({
			videoId,
			userId,
			verification,
		});
	} catch (error) {
		if (error instanceof SourceCommitPendingError) return "source-committing";
		if (error instanceof DesktopRecordingSourceBlockedError)
			return "source-incomplete";
		console.error(
			"[desktop-segments-recovery] Durable recovery dispatch failed",
			{ videoId, error },
		);
		return "failed";
	}
}

export async function recoverStaleDesktopSegments({
	now = new Date(),
	limit = DESKTOP_SEGMENTS_RECOVERY_BATCH_SIZE,
}: {
	now?: Date;
	limit?: number;
} = {}): Promise<StaleDesktopSegmentsRecoverySummary> {
	const batchSize = Math.max(1, Math.min(limit, 100));
	const legacyReserve =
		batchSize > 1 ? Math.max(1, Math.floor(batchSize / 4)) : 0;
	const jobs = await listRecoverableSegmentJobs({
		now,
		limit: batchSize - legacyReserve,
	});
	const summary: StaleDesktopSegmentsRecoverySummary = {
		checked: 0,
		statuses: {},
		results: [],
	};
	const record = (
		videoId: Video.VideoId,
		status: StaleDesktopSegmentsRecoveryStatus,
	) => {
		summary.checked++;
		summary.statuses[status] = (summary.statuses[status] ?? 0) + 1;
		summary.results.push({ videoId, status });
	};
	for (const job of jobs) {
		record(
			job.videoId,
			await recoverRecording({
				videoId: job.videoId,
				userId: job.ownerId,
				verification: job.verification ?? undefined,
			}),
		);
	}
	const remaining = batchSize - jobs.length;
	if (remaining <= 0) return summary;
	const staleBefore = new Date(
		now.getTime() - DESKTOP_SEGMENTS_RECOVERY_MIN_AGE_MS,
	);
	const legacy = await db()
		.select({ videoId: videos.id, ownerId: videos.ownerId })
		.from(videoUploads)
		.innerJoin(videos, eq(videoUploads.videoId, videos.id))
		.leftJoin(
			videoProcessingJobs,
			eq(videoUploads.videoId, videoProcessingJobs.videoId),
		)
		.where(
			and(
				inArray(videoUploads.phase, RECOVERABLE_UPLOAD_PHASES),
				lte(videoUploads.updatedAt, staleBefore),
				isNull(videoProcessingJobs.videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.type')) = 'desktopSegments'`,
			),
		)
		.orderBy(asc(videoUploads.updatedAt), asc(videoUploads.videoId))
		.limit(remaining);
	for (const candidate of legacy) {
		record(
			candidate.videoId,
			await recoverRecording({
				videoId: candidate.videoId,
				userId: candidate.ownerId,
			}),
		);
	}
	return summary;
}
