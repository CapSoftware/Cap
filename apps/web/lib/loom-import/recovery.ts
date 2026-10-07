import { db } from "@cap/database";
import {
	loomImportJobItems,
	loomImportJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { and, eq, lt } from "drizzle-orm";
import { start } from "workflow/api";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";
import { loomImportJobWorkflow } from "@/workflows/loom-import-job";
import { dispatchLoomImportJob, rawFileKeyFor } from "./dispatch";
import { affectedRows } from "./jobs";

const STALE_CHECKING_MS = 10 * 60 * 1000;
const STALE_IMPORTING_MS = 2 * 60 * 1000;
const STUCK_START_MS = 30 * 60 * 1000;

export async function recoverLoomImportJobs(now = new Date(), limit = 20) {
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

	const staleImporting = await db()
		.select({ id: loomImportJobs.id })
		.from(loomImportJobs)
		.where(
			and(
				eq(loomImportJobs.status, "importing"),
				lt(
					loomImportJobs.updatedAt,
					new Date(now.getTime() - STALE_IMPORTING_MS),
				),
			),
		)
		.limit(limit);

	let restarted = 0;
	for (const job of staleImporting) {
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
					eq(loomImportJobItems.jobId, job.id),
					eq(loomImportJobItems.status, "importing"),
					eq(videoUploads.phase, "uploading"),
					lt(videoUploads.updatedAt, new Date(now.getTime() - STUCK_START_MS)),
				),
			);
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
		await dispatchLoomImportJob(job.id);
	}

	return {
		checking: staleChecking.length,
		resumed,
		importing: staleImporting.length,
		restarted,
	};
}
