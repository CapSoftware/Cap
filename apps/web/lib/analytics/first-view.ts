import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

const getAffectedRows = (result: unknown) =>
	Array.isArray(result)
		? ((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
		: ((result as { affectedRows?: number } | undefined)?.affectedRows ?? 0);

export const firstExternalViewTimestamp = (now = Date.now()) =>
	new Date(Math.floor(now / 1_000) * 1_000);

export async function claimFirstExternalView(
	videoId: Video.VideoId,
	claimedAt: Date,
) {
	const result = await db()
		.update(videos)
		.set({ firstExternalViewAt: claimedAt })
		.where(and(eq(videos.id, videoId), isNull(videos.firstExternalViewAt)));
	return getAffectedRows(result) === 1;
}
