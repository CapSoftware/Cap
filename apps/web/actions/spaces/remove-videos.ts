"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, spaceVideos, videos } from "@cap/database/schema";
import type { Space, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeVideosFromSpace(
	spaceId: Space.SpaceIdOrOrganisationId,
	videoIds: Video.VideoId[],
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!spaceId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		// Only allow removing videos the user owns
		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		if (isAllSpacesEntry) {
			await db()
				.delete(sharedVideos)
				.where(
					and(
						eq(sharedVideos.organizationId, spaceId),
						inArray(sharedVideos.videoId, validVideoIds),
					),
				);
		} else {
			await db()
				.delete(spaceVideos)
				.where(
					and(
						eq(spaceVideos.spaceId, spaceId),
						inArray(spaceVideos.videoId, validVideoIds),
					),
				);
		}

		revalidatePath(`/dashboard/spaces/${spaceId}`);

		return {
			success: true,
			message: `Removed ${validVideoIds.length} video(s) from ${isAllSpacesEntry ? "organization" : "space"} and folders`,
			deletedCount: validVideoIds.length,
		};
	} catch (error) {
		return {
			success: false,
			message:
				error instanceof Error
					? error.message
					: "Failed to remove videos from space",
		};
	}
}
