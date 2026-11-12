import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
	deleteDeveloperVideoObjects,
	developerVideoPrefix,
} from "./developer-video-storage";

// Media server upload links last 3 hours, so a job still running when its
// video was deleted can write files after the first purge. One more pass once
// that window has closed catches them.
export const DEVELOPER_VIDEO_LATE_WRITE_HOURS = 4;
// Runs every five minutes, so a batch only has to keep up with deletes. The
// CDN re-checks these files with storage on the same interval, so removing
// the files is what takes a deleted video away from links already handed out.
const PURGE_BATCH = 200;

type PurgeRow = { id: string; appId: string };
type PurgeResult = { purged: number; failed: number };

type PurgeBudget = { stopAt: number; perVideoMs: number };

function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Deletion timed out")), ms);
	});
	return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

async function purgeFiles(
	rows: PurgeRow[],
	purgedColumns: () => Partial<typeof developerVideos.$inferInsert>,
	budget?: PurgeBudget,
): Promise<PurgeResult> {
	let purged = 0;
	let failed = 0;
	for (const row of rows) {
		if (budget && Date.now() >= budget.stopAt) break;
		try {
			const deletion = deleteDeveloperVideoObjects(developerVideoPrefix(row));
			await (budget ? within(deletion, budget.perVideoMs) : deletion);
			await db()
				.update(developerVideos)
				.set(purgedColumns())
				.where(eq(developerVideos.id, row.id));
			purged++;
		} catch (error) {
			failed++;
			console.error("[developer-video-purge] Failed to delete files", {
				videoId: row.id,
				error,
			});
		}
	}
	return { purged, failed };
}

export async function purgeDeletedDeveloperVideos(
	limit = PURGE_BATCH,
): Promise<PurgeResult> {
	const hours = sql.raw(String(DEVELOPER_VIDEO_LATE_WRITE_HOURS));
	// A video counts as deleted when it was deleted itself or its app was.
	// Apps deleted before videos were marked along with them only carry the
	// app's timestamp.
	const deletedAt = sql`COALESCE(${developerVideos.deletedAt}, ${developerApps.deletedAt})`;
	const rows = await db()
		.select({ id: developerVideos.id, appId: developerVideos.appId })
		.from(developerVideos)
		.innerJoin(developerApps, eq(developerApps.id, developerVideos.appId))
		.where(
			and(
				or(
					isNotNull(developerVideos.deletedAt),
					isNotNull(developerApps.deletedAt),
				),
				or(
					isNull(developerVideos.filesDeletedAt),
					and(
						sql`${developerVideos.filesDeletedAt} < ${deletedAt} + INTERVAL ${hours} HOUR`,
						sql`${deletedAt} <= NOW() - INTERVAL ${hours} HOUR`,
					),
				),
			),
		)
		.orderBy(asc(deletedAt))
		.limit(limit);

	return purgeFiles(rows, () => ({ filesDeletedAt: new Date() }));
}

// A failed video is not billed, so its files are kept for a day and then
// removed. The day is counted from when processing started: that is the one
// time on the row its owner cannot move (renaming the video moves updatedAt),
// and it is past the late write window above by the time the files go.
export const FAILED_VIDEO_FILES_KEPT_MS = 24 * 60 * 60 * 1000;
// This pass shares the hourly cleanup's five minutes with three others, so it
// stops taking videos after a minute and gives up on a deletion that hangs.
// A video it did not reach, or whose deletion it stopped waiting for, is not
// marked and is picked up by a later run.
const FAILED_PURGE_BUDGET_MS = 60_000;
const FAILED_PURGE_DELETE_TIMEOUT_MS = 20_000;

function failedVideos(
	startedBefore: number,
	limit: number,
	range: { after: string } | { upTo: string },
): Promise<PurgeRow[]> {
	return db()
		.select({ id: developerVideos.id, appId: developerVideos.appId })
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.status, "errored"),
				isNull(developerVideos.filesDeletedAt),
				isNull(developerVideos.deletedAt),
				sql`JSON_EXTRACT(${developerVideos.processing}, '$.startedAt') <= ${startedBefore}`,
				"after" in range
					? gt(developerVideos.id, range.after)
					: lte(developerVideos.id, range.upTo),
			),
		)
		.orderBy(asc(developerVideos.id))
		.limit(limit);
}

// Removes the files of videos that failed more than a day ago and keeps their
// rows, so the owner still sees the video and why it failed. Errored is a
// final state: such a video is never encoded again and cannot take another
// upload, so nothing later needs these files. Each run starts from a random
// place and wraps around, so files that cannot be deleted do not hold up the
// videos behind them.
export async function purgeFailedDeveloperVideoFiles(
	limit = PURGE_BATCH,
	now: number = Date.now(),
	start: string = nanoId(),
): Promise<PurgeResult> {
	const startedBefore = now - FAILED_VIDEO_FILES_KEPT_MS;
	const rows = await failedVideos(startedBefore, limit, { after: start });
	if (rows.length < limit) {
		rows.push(
			...(await failedVideos(startedBefore, limit - rows.length, {
				upTo: start,
			})),
		);
	}
	return purgeFiles(
		rows,
		() => ({ filesDeletedAt: new Date(), storedBytes: 0 }),
		{
			stopAt: Date.now() + FAILED_PURGE_BUDGET_MS,
			perVideoMs: FAILED_PURGE_DELETE_TIMEOUT_MS,
		},
	);
}
