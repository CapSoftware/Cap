"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, spaceVideos, videos } from "@cap/database/schema";
import type { Space, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";

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

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		if (isAllSpacesEntry) {
			await requireOrganizationSettingsManager(user.id, spaceId);
		} else {
			const access = await getSpaceAccess(user.id, spaceId);
			if (!access?.canManage) {
				throw new Error(
					"You don't have permission to remove videos from this space",
				);
			}
		}

		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

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
