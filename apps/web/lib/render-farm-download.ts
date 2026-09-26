import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { refreshRenderFarmExports } from "@/lib/render-farm-save";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";

/** A video's background exports, for its owner only. */
export async function loadOwnedRenderExports(
	videoId: Video.VideoId,
	user: { id: string; email: string } | null | undefined,
) {
	if (!user || !isWebStudioEnabledForEmail(user.email)) return null;
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video || video.ownerId !== user.id) return null;
	return { video, exports: await refreshRenderFarmExports(video) };
}
