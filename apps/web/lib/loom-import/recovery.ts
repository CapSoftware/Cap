import { db } from "@cap/database";
import {
	loomImportJobItems,
	loomImportJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import { start } from "workflow/api";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";
import { loomImportJobWorkflow } from "@/workflows/loom-import-job";
import { dispatchLoomImports, rawFileKeyFor } from "./dispatch";
import { affectedRows } from "./jobs";

const STALE_CHECKING_MS = 10 * 60 * 1000;
const STUCK_START_MS = 30 * 60 * 1000;
const SILENT_IMPORT_MS = 2 * 60 * 60 * 1000;
const SILENT_IMPORT_BATCH = 500;
export const LOOM_IMPORT_SILENT_ERROR =
	"This video stopped responding while it was copying. Try it again.";

async function resumeStaleChecks(now: Date, limit: number) {
	const staleChecking = await db()
		.select({ id: loomImportJobs.id, updatedAt: loomImportJobs.updatedAt })
		.from(loomImportJobs)
		.where(
			and(
				eq(loomImportJobs.status, "checking"),
				lt(
					loomImportJobs.updatedAt,
					new Date(now.getTime() - STALE_CHECKING_MS),
				),
			),
		)
		.limit(limit);

	let resumed = 0;
	for (const job of staleChecking) {
		const claim = await db()
			.update(loomImportJobs)
			.set({ updatedAt: now })
			.where(
				and(
					eq(loomImportJobs.id, job.id),
					eq(loomImportJobs.status, "checking"),
					eq(loomImportJobs.updatedAt, job.updatedAt),
				),
			);
		if (affectedRows(claim) !== 1) continue;
		try {
			await start(loomImportJobWorkflow, [{ jobId: job.id }]);
			resumed++;
		} catch (error) {
			console.error("[loom-import] Could not resume import job", {
				jobId: job.id,
				error,
			});
		}
	}
	return { checking: staleChecking.length, resumed };
}

async function restartStuckStarts(now: Date, limit: number) {
	const stuck = await db()
		.select({
			videoId: videos.id,
			ownerId: videos.ownerId,
			bucket: videos.bucket,
			loomVideoId: loomImportJobItems.loomVideoId,
			rawFileKey: videoUploads.rawFileKey,
			uploadUpdatedAt: videoUploads.updatedAt,
		})
		.from(loomImportJobItems)
		.innerJoin(videos, eq(videos.id, loomImportJobItems.videoId))
		.innerJoin(
			videoUploads,
			eq(videoUploads.videoId, loomImportJobItems.videoId),
		)
		.where(
			and(
				eq(loomImportJobItems.status, "importing"),
				eq(videoUploads.phase, "uploading"),
				lt(videoUploads.updatedAt, new Date(now.getTime() - STUCK_START_MS)),
			),
		)
		.limit(limit);

	let restarted = 0;
	for (const row of stuck) {
		if (!row.loomVideoId) continue;
		const rawFileKey =
			row.rawFileKey ?? rawFileKeyFor(row.ownerId, row.videoId);
		const claim = await db()
			.update(videoUploads)
			.set({
				processingMessage: "Retrying Loom import...",
				rawFileKey,
				updatedAt: now,
			})
			.where(
				and(
					eq(videoUploads.videoId, row.videoId),
					eq(videoUploads.phase, "uploading"),
					eq(videoUploads.updatedAt, row.uploadUpdatedAt),
				),
			);
		if (affectedRows(claim) !== 1) continue;
		try {
			await start(importLoomVideoWorkflow, [
				{
					videoId: row.videoId,
					userId: row.ownerId,
					rawFileKey,
					bucketId: row.bucket,
					loomVideoId: row.loomVideoId,
					reuseExistingRawUpload: true,
				},
			]);
			restarted++;
		} catch (error) {
			console.error("[loom-import] Could not restart stuck import", {
				videoId: row.videoId,
				error,
			});
		}
	}
	return restarted;
}

async function failSilentImports(now: Date) {
	const silentSince = new Date(now.getTime() - SILENT_IMPORT_MS);
	const silentPhases = [
		"uploading",
		"processing",
		"generating_thumbnail",
	] as const;
	const silent = await db()
		.select({ videoId: videoUploads.videoId })
		.from(loomImportJobItems)
		.innerJoin(
			videoUploads,
			eq(videoUploads.videoId, loomImportJobItems.videoId),
		)
		.where(
			and(
				eq(loomImportJobItems.status, "importing"),
				inArray(videoUploads.phase, silentPhases),
				lt(videoUploads.updatedAt, silentSince),
			),
		)
		.limit(SILENT_IMPORT_BATCH);
	if (silent.length === 0) return 0;

	const result = await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingError: LOOM_IMPORT_SILENT_ERROR,
			processingMessage: "Loom import failed",
			updatedAt: now,
		})
		.where(
			and(
				inArray(
					videoUploads.videoId,
					silent.map((row) => row.videoId),
				),
				inArray(videoUploads.phase, silentPhases),
				lt(videoUploads.updatedAt, silentSince),
			),
		);
	return affectedRows(result);
}

export async function recoverLoomImportJobs(now = new Date(), limit = 20) {
	const { checking, resumed } = await resumeStaleChecks(now, limit);
	const restarted = await restartStuckStarts(now, limit);
	const silent = await failSilentImports(now);
	const dispatched = await dispatchLoomImports();
	return {
		checking,
		resumed,
		restarted,
		silent,
		started: dispatched.started,
		inFlight: dispatched.inFlight,
		waiting: dispatched.waiting,
	};
}
