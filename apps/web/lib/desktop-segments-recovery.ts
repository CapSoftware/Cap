import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import {
	and,
	asc,
	eq,
	inArray,
	isNull,
	lte,
	notLike,
	or,
	sql,
} from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
	type DesktopSegmentsFinalizationStatus,
	queueDesktopSegmentsFinalization,
} from "@/lib/desktop-segments-finalization";
import {
	buildDesktopSegmentsRecoveryMarker,
	getDesktopSegmentsManifestSignature,
	parseDesktopSegmentsRecoveryMarker,
} from "@/lib/desktop-segments-recovery-marker";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

const MINUTE = 60 * 1000;

export const DESKTOP_SEGMENTS_RECOVERY_MIN_AGE_MS = 60 * MINUTE;
export const DESKTOP_SEGMENTS_RECOVERY_STABILITY_MS = 15 * MINUTE;
export const DESKTOP_SEGMENTS_RECOVERY_BATCH_SIZE = 20;

const RECOVERABLE_UPLOAD_PHASES = ["uploading", "error"] as const;

// After this many consecutive scans where a candidate is unrecoverable
// (missing manifest, no segments, ...), it is retired from the scan queue so
// dead rows can't permanently clog the head of the updatedAt-ordered scan.
export const DESKTOP_SEGMENTS_RECOVERY_MAX_DEAD_ATTEMPTS = 3;
const DEAD_MARKER_SIGNATURE = "dead";
const RECOVERY_ABANDONED_PREFIX = "recovery-abandoned:";

type DesktopSegmentsRecoveryResult =
	| {
			status: DesktopSegmentsFinalizationStatus;
			manifestCompleted: boolean;
			videoSegments: number;
			audioSegments: number;
	  }
	| { status: "already-finalized" }
	| { status: "not-found" }
	| { status: "not-segmented" }
	| { status: "missing-manifest" }
	| { status: "invalid-manifest"; error: string }
	| { status: "no-video-segments" }
	| { status: "manifest-changed" };

export type StaleDesktopSegmentsRecoveryStatus =
	| DesktopSegmentsRecoveryResult["status"]
	| "observing"
	| "waiting-for-stability"
	| "failed";

export type StaleDesktopSegmentsRecoverySummary = {
	checked: number;
	statuses: Partial<Record<StaleDesktopSegmentsRecoveryStatus, number>>;
	results: Array<{
		videoId: Video.VideoId;
		status: StaleDesktopSegmentsRecoveryStatus;
	}>;
};

type DesktopSegmentsVideo = typeof videos.$inferSelect;

type LoadedDesktopSegmentsManifest =
	| {
			status: "loaded";
			video: DesktopSegmentsVideo;
			manifestKey: string;
			manifest: Video.SegmentManifestType;
			bucket: Awaited<
				ReturnType<typeof Storage.getAccessForVideo> extends Effect.Effect<
					infer A,
					unknown,
					unknown
				>
					? Promise<A>
					: never
			>[0];
	  }
	| { status: "already-finalized" }
	| { status: "not-found" }
	| { status: "not-segmented" }
	| { status: "missing-manifest" }
	| { status: "invalid-manifest"; error: string };

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function decodeSegmentManifest(
	manifestJson: string,
): Promise<
	| { status: "loaded"; manifest: Video.SegmentManifestType }
	| { status: "invalid-manifest"; error: string }
> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestJson);
	} catch (error) {
		return { status: "invalid-manifest", error: getErrorMessage(error) };
	}

	try {
		const manifest = await Schema.decodeUnknown(Video.SegmentManifest)(parsed)
			.pipe(Effect.mapError(getErrorMessage))
			.pipe(runPromise);

		return { status: "loaded", manifest };
	} catch (error) {
		return { status: "invalid-manifest", error: getErrorMessage(error) };
	}
}

async function loadDesktopSegmentsManifest({
	videoId,
	userId,
}: {
	videoId: Video.VideoId;
	userId?: User.UserId;
}): Promise<LoadedDesktopSegmentsManifest> {
	const where = userId
		? and(eq(videos.id, videoId), eq(videos.ownerId, userId))
		: eq(videos.id, videoId);

	const [video] = await db().select().from(videos).where(where).limit(1);

	if (!video) return { status: "not-found" };
	if (video.source?.type === "desktopMP4")
		return { status: "already-finalized" };
	if (video.source?.type !== "desktopSegments")
		return { status: "not-segmented" };

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	const segSource = new Video.SegmentsSource({
		videoId,
		ownerId: video.ownerId,
	});
	const manifestKey = segSource.getManifestKey();
	const manifestContent = await bucket.getObject(manifestKey).pipe(runPromise);
	const manifestJson = Option.getOrNull(manifestContent);

	if (!manifestJson) return { status: "missing-manifest" };

	const decoded = await decodeSegmentManifest(manifestJson);
	if (decoded.status !== "loaded") return decoded;

	return {
		status: "loaded",
		video,
		manifestKey,
		manifest: decoded.manifest,
		bucket,
	};
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

	const signature = getDesktopSegmentsManifestSignature(loaded.manifest);
	if (expectedManifestSignature && signature !== expectedManifestSignature) {
		return { status: "manifest-changed" };
	}

	let manifestCompleted = false;
	if (!loaded.manifest.is_complete) {
		const completedManifest = {
			...loaded.manifest,
			is_complete: true,
		};
		const body = JSON.stringify(completedManifest, null, 2);
		await loaded.bucket
			.putObject(loaded.manifestKey, body, {
				contentType: "application/json",
				contentLength: Buffer.byteLength(body),
			})
			.pipe(runPromise);
		manifestCompleted = true;
	}

	const status = await queueDesktopSegmentsFinalization({
		videoId,
		userId: loaded.video.ownerId,
	});

	return {
		status,
		manifestCompleted,
		videoSegments: loaded.manifest.video_segments.length,
		audioSegments: loaded.manifest.audio_segments.length,
	};
}

async function markCandidateObserved({
	videoId,
	signature,
	now,
}: {
	videoId: Video.VideoId;
	signature: string;
	now: Date;
}) {
	await db()
		.update(videoUploads)
		.set({
			processingMessage: buildDesktopSegmentsRecoveryMarker(
				signature,
				now.getTime(),
			),
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				inArray(videoUploads.phase, RECOVERABLE_UPLOAD_PHASES),
			),
		);
}

async function retireCandidate({
	videoId,
	status,
	now,
}: {
	videoId: Video.VideoId;
	status: StaleDesktopSegmentsRecoveryStatus;
	now: Date;
}) {
	await db()
		.update(videoUploads)
		.set({
			updatedAt: now,
			// Terminal phase so viewers stop seeing an eternal "uploading" state;
			// the desktop can still revive it by re-uploading and re-queueing.
			phase: "error",
			processingError: `${RECOVERY_ABANDONED_PREFIX} ${status} — the upload was interrupted and could not be recovered automatically. Reopen Cap on the recording device to retry, or record again.`,
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				inArray(videoUploads.phase, RECOVERABLE_UPLOAD_PHASES),
			),
		);
}

async function recordDeadCandidateObservation({
	videoId,
	status,
	marker,
	now,
}: {
	videoId: Video.VideoId;
	status: StaleDesktopSegmentsRecoveryStatus;
	marker: ReturnType<typeof parseDesktopSegmentsRecoveryMarker>;
	now: Date;
}) {
	const attempts =
		(marker?.signature === DEAD_MARKER_SIGNATURE ? marker.attempts : 0) + 1;

	if (attempts >= DESKTOP_SEGMENTS_RECOVERY_MAX_DEAD_ATTEMPTS) {
		await retireCandidate({ videoId, status, now });
		return;
	}

	// Bump updatedAt so the candidate rotates to the back of the
	// updatedAt-ordered scan instead of blocking the queue head.
	await db()
		.update(videoUploads)
		.set({
			updatedAt: now,
			processingMessage: buildDesktopSegmentsRecoveryMarker(
				DEAD_MARKER_SIGNATURE,
				now.getTime(),
				attempts,
			),
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				inArray(videoUploads.phase, RECOVERABLE_UPLOAD_PHASES),
			),
		);
}

async function recoverStaleDesktopSegmentsCandidate({
	videoId,
	processingMessage,
	now,
}: {
	videoId: Video.VideoId;
	processingMessage: string | null;
	now: Date;
}): Promise<StaleDesktopSegmentsRecoveryStatus> {
	const marker = parseDesktopSegmentsRecoveryMarker(processingMessage);
	const loaded = await loadDesktopSegmentsManifest({ videoId });

	if (loaded.status === "already-finalized") {
		// The upload row outlived finalization; retire it immediately so it
		// stops occupying the scan queue.
		await retireCandidate({ videoId, status: loaded.status, now });
		return loaded.status;
	}

	if (loaded.status !== "loaded") {
		await recordDeadCandidateObservation({
			videoId,
			status: loaded.status,
			marker,
			now,
		});
		return loaded.status;
	}

	if (
		!loaded.manifest.video_init_uploaded ||
		loaded.manifest.video_segments.length === 0
	) {
		await recordDeadCandidateObservation({
			videoId,
			status: "no-video-segments",
			marker,
			now,
		});
		return "no-video-segments";
	}

	if (loaded.manifest.is_complete) {
		return (
			await completeDesktopSegmentsManifestAndQueue({
				videoId,
				expectedManifestSignature: getDesktopSegmentsManifestSignature(
					loaded.manifest,
				),
			})
		).status;
	}

	const signature = getDesktopSegmentsManifestSignature(loaded.manifest);

	if (marker?.signature !== signature) {
		await markCandidateObserved({ videoId, signature, now });
		return "observing";
	}

	if (
		now.getTime() - marker.observedAtMs <
		DESKTOP_SEGMENTS_RECOVERY_STABILITY_MS
	) {
		return "waiting-for-stability";
	}

	return (
		await completeDesktopSegmentsManifestAndQueue({
			videoId,
			expectedManifestSignature: signature,
		})
	).status;
}

export async function recoverStaleDesktopSegments({
	now = new Date(),
	limit = DESKTOP_SEGMENTS_RECOVERY_BATCH_SIZE,
}: {
	now?: Date;
	limit?: number;
} = {}): Promise<StaleDesktopSegmentsRecoverySummary> {
	const staleBefore = new Date(
		now.getTime() - DESKTOP_SEGMENTS_RECOVERY_MIN_AGE_MS,
	);
	const candidates = await db()
		.select({
			videoId: videos.id,
			processingMessage: videoUploads.processingMessage,
		})
		.from(videos)
		.innerJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.type')) = 'desktopSegments'`,
				lte(videos.createdAt, staleBefore),
				lte(videoUploads.updatedAt, staleBefore),
				inArray(videoUploads.phase, RECOVERABLE_UPLOAD_PHASES),
				or(
					isNull(videoUploads.processingError),
					notLike(
						videoUploads.processingError,
						`${RECOVERY_ABANDONED_PREFIX}%`,
					),
				),
			),
		)
		.orderBy(asc(videoUploads.updatedAt))
		.limit(limit);

	const summary: StaleDesktopSegmentsRecoverySummary = {
		checked: candidates.length,
		statuses: {},
		results: [],
	};

	for (const candidate of candidates) {
		let status: StaleDesktopSegmentsRecoveryStatus;
		try {
			status = await recoverStaleDesktopSegmentsCandidate({
				videoId: candidate.videoId,
				processingMessage: candidate.processingMessage,
				now,
			});
		} catch (error) {
			status = "failed";
			console.error(
				`[desktop-segments-recovery] Failed to recover ${candidate.videoId}:`,
				error,
			);
			// A candidate that keeps throwing must still rotate/retire, or it
			// blocks the queue head forever.
			try {
				await recordDeadCandidateObservation({
					videoId: Video.VideoId.make(candidate.videoId),
					status: "failed",
					marker: parseDesktopSegmentsRecoveryMarker(
						candidate.processingMessage,
					),
					now,
				});
			} catch (markError) {
				console.error(
					`[desktop-segments-recovery] Failed to mark ${candidate.videoId}:`,
					markError,
				);
			}
		}

		summary.statuses[status] = (summary.statuses[status] ?? 0) + 1;
		summary.results.push({ videoId: candidate.videoId, status });
	}

	return summary;
}
