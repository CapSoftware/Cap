import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
	deleteDeveloperVideoObjects,
	developerVideoPrefix,
} from "./developer-video-storage";

// Media server upload links last 3 hours, so a job still running when its
// video was deleted can write files after the first purge. One more pass once
// that window has closed catches them.
export const DEVELOPER_VIDEO_LATE_WRITE_HOURS = 4;
const PURGE_BATCH = 100;

export async function purgeDeletedDeveloperVideos(
	limit = PURGE_BATCH,
): Promise<{ purged: number; failed: number }> {
	const hours = DEVELOPER_VIDEO_LATE_WRITE_HOURS;
	const rows = await db()
		.select({ id: developerVideos.id, appId: developerVideos.appId })
		.from(developerVideos)
		.where(
			and(
				isNotNull(developerVideos.deletedAt),
				or(
					isNull(developerVideos.filesDeletedAt),
					and(
						sql`${developerVideos.filesDeletedAt} < ${developerVideos.deletedAt} + INTERVAL ${sql.raw(String(hours))} HOUR`,
						sql`${developerVideos.deletedAt} <= NOW() - INTERVAL ${sql.raw(String(hours))} HOUR`,
					),
				),
			),
		)
		.orderBy(asc(developerVideos.deletedAt))
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
