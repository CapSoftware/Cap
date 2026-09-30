import "server-only";

import type { users } from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import type { InferSelectModel } from "drizzle-orm";
import { isVideoOwnerPro } from "@/lib/org-pro";

/**
 * Recording media comments (video/voice replies on the share-page timeline) is
 * part of the VIDEO OWNER's Pro plan: any signed-in viewer can record on a Pro
 * owner's video. Viewing/playing media comments is never gated here — that
 * follows the video's normal view policy.
 */
export async function canUseMediaComments(
	user: Pick<InferSelectModel<typeof users>, "id"> | null,
	video: { ownerId: User.UserId; id: Video.VideoId },
): Promise<boolean> {
	if (!user) return false;
	return isVideoOwnerPro(video.ownerId);
}
