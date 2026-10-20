import { db } from "@cap/database";
import { loomImportJobItems } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

export async function markLoomImportRetrying(videoId: Video.VideoId) {
	try {
		await db()
			.update(loomImportJobItems)
			.set({ status: "importing", error: null, updatedAt: new Date() })
			.where(
				and(
					eq(loomImportJobItems.videoId, videoId),
					eq(loomImportJobItems.status, "failed"),
				),
			);
	} catch (error) {
		console.warn("[loom-import] Could not show a retry on its import", {
			videoId,
			error,
		});
	}
}
