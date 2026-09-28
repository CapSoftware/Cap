import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { isMediaServerConfigured } from "@/lib/media-client";
import { getReplacementAwaitingPreviewAssets } from "@/lib/published-preview-assets";
import { refreshPreviewAssetsWorkflow } from "@/workflows/refresh-preview-assets";

/**
 * Remakes the thumbnail and preview GIF after a render or reupload replaced
 * the share video. Best effort: the share video is already published.
 */
export async function enqueuePreviewAssetsRefresh(
	videoId: Video.VideoId,
): Promise<void> {
	try {
		if (!isMediaServerConfigured()) return;
		const [video] = await db()
			.select({ id: videos.id, ownerId: videos.ownerId, source: videos.source })
			.from(videos)
			.where(eq(videos.id, videoId));
		const outputKey = video && getReplacementAwaitingPreviewAssets(video);
		if (!outputKey) return;
		await start(refreshPreviewAssetsWorkflow, [{ videoId, outputKey }]);
	} catch (error) {
		console.error("Failed to queue preview asset refresh", { videoId, error });
	}
}
