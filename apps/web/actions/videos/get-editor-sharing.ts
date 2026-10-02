"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { getDashboardSpacesData } from "@/app/(org)/dashboard/dashboard-data";
import { getSharedSpacesForVideo } from "@/lib/video-shared-spaces";

/** What the editor's sharing controls need for the owner's own recording. */
export async function getEditorSharing(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			isPublic: videos.public,
			hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
		})
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video || video.ownerId !== user.id) throw new Error("Video not found");
	const [{ sharedSpaces }, spacesData] = await Promise.all([
		getSharedSpacesForVideo(videoId),
		getDashboardSpacesData(user),
	]);
	return {
		isPublic: video.isPublic,
		hasPassword: video.hasPassword,
		sharedSpaces,
		spacesData,
	};
}
