"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export async function updateVideoSettings(
	videoId: Video.VideoId,
	videoSettings: {
		disableSummary?: boolean;
		disableCaptions?: boolean;
		disableChapters?: boolean;
		disableReactions?: boolean;
		disableTranscript?: boolean;
		disableComments?: boolean;
	},
) {
	const user = await getCurrentUser();

	if (!user || !videoId || !videoSettings) {
		throw new Error("Missing required data for updating video settings");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) {
		throw new Error("Video not found for updating video settings");
	}

	if (video.ownerId !== user.id) {
		throw new Error("You don't have permission to update this video settings");
	}

	await db()
		.update(videos)
		.set({ settings: videoSettings })
		.where(eq(videos.id, videoId));

	return { success: true };
}
