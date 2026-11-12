import { db } from "@cap/database";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
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

export async function purgeDeletedDeveloperVideos(
	limit = PURGE_BATCH,
): Promise<{ purged: number; failed: number }> {
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

	let purged = 0;
	let failed = 0;
	for (const row of rows) {
		try {
			await deleteDeveloperVideoObjects(developerVideoPrefix(row));
			await db()
				.update(developerVideos)
				.set({ filesDeletedAt: new Date() })
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
