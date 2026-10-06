import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { syncVideoStorageNamesWorkflow } from "@/workflows/sync-video-storage-names";

export async function enqueueVideoStorageNameSync(
	videoId: Video.VideoId,
): Promise<void> {
	try {
		const [video] = await db()
			.select({ storageIntegrationId: videos.storageIntegrationId })
			.from(videos)
			.where(eq(videos.id, videoId));
		if (!video?.storageIntegrationId) return;

		await start(syncVideoStorageNamesWorkflow, [{ videoId }]);
	} catch (error) {
		console.error("Failed to queue video storage name sync", {
			videoId,
			error,
		});
	}
}
