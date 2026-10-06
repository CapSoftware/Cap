"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { normalizePlaybackSpeed } from "@/lib/playback-speed";

const VIEWER_SETTING_KEYS = [
	"disableSummary",
	"disableCaptions",
	"disableChapters",
	"disableReactions",
	"disableTranscript",
	"disableComments",
] as const;

export async function updateVideoSettings(
	videoId: Video.VideoId,
	videoSettings: {
		disableSummary?: boolean;
		disableCaptions?: boolean;
		disableChapters?: boolean;
		disableReactions?: boolean;
		disableTranscript?: boolean;
		disableComments?: boolean;
		defaultPlaybackSpeed?: number;
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

	const settingsToSave: Record<string, boolean | number> = {};
	for (const key of VIEWER_SETTING_KEYS) {
		const value = videoSettings[key];
		if (typeof value === "boolean") settingsToSave[key] = value;
	}
	if (videoSettings.defaultPlaybackSpeed !== undefined) {
		settingsToSave.defaultPlaybackSpeed = normalizePlaybackSpeed(
			videoSettings.defaultPlaybackSpeed,
		);
	}

	await db()
		.update(videos)
		.set({
			settings: sql`JSON_MERGE_PATCH(COALESCE(${videos.settings}, JSON_OBJECT()), CAST(${JSON.stringify(settingsToSave)} AS JSON))`,
		})
		.where(eq(videos.id, videoId));

	return { success: true };
}
