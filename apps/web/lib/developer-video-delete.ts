import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { cancelDeveloperVideoEncodes } from "./developer-video-cancel";
import { settleFirstMonthAtDelete } from "./infra-storage-minimum";

// The customer DELETE and the staff delete both run this, so a deleted video
// is billed and its encodes stopped the same way whoever deleted it.
export async function markDeveloperVideoDeleted(
	video: { appId: string; videoId: string },
	now: Date = new Date(),
): Promise<void> {
	await db()
		.update(developerVideos)
		.set({ deletedAt: now })
		.where(eq(developerVideos.id, video.videoId));
	await settleFirstMonthAtDelete(video.videoId);
	await cancelDeveloperVideoEncodes(video);
}
