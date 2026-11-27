"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { getDashboardSpacesData } from "@/app/(org)/dashboard/dashboard-data";
import { getSharedSpacesForVideo } from "@/lib/video-shared-spaces";

export async function getEditorSharing(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			isPublic: videos.public,
			hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
			videoSettings: videos.settings,
			orgSettings: organizations.settings,
			allowedEmailDomain: organizations.allowedEmailDomain,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));
	if (!video || video.ownerId !== user.id) throw new Error("Video not found");
	const [{ sharedSpaces }, spacesData] = await Promise.all([
		getSharedSpacesForVideo(videoId),
		getDashboardSpacesData(user),
	]);
	return {
		isPublic: video.isPublic,
		hasPassword: video.hasPassword,
		allowedEmailDomain: video.allowedEmailDomain ?? null,
		allowLinkOverride: video.orgSettings?.allowPublicLinkOverride === true,
		linkOpenToAnyone: video.videoSettings?.linkAccess === "anyone",
		sharedSpaces,
		spacesData,
	};
}
