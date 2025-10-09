"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	folders,
	sharedVideos,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Space, Video } from "@cap/web-domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
			// Remove from organization level (sharedVideos table)
			await db()
				.delete(sharedVideos)
				.where(
					and(
						eq(sharedVideos.organizationId, spaceId),
						inArray(sharedVideos.videoId, validVideoIds),
					),
				);

			// Set folderId to null for any removed videos that are in org-level folders
			const folderRows = await db()
				.select({ id: folders.id })
				.from(folders)
				.where(
					and(
						isNull(folders.spaceId),
						eq(folders.organizationId, user.activeOrganizationId),
					),
				);

			const folderIds = folderRows.map((f) => f.id);

			if (folderIds.length > 0) {
				await db()
					.update(videos)
					.set({ folderId: null })
					.where(
						and(
							inArray(videos.id, validVideoIds),
							inArray(videos.folderId, folderIds),
						),
					);
			}
		} else {
			// Remove from specific space (spaceVideos table)
			await db()
				.delete(spaceVideos)
				.where(
					and(
						eq(spaceVideos.spaceId, spaceId),
						inArray(spaceVideos.videoId, validVideoIds),
					),
				);

			// Set folderId to null for any removed videos that are in folders belonging to this space
			const folderRows = await db()
				.select({ id: folders.id })
				.from(folders)
				.where(
					and(
						isNull(folders.spaceId),
						eq(folders.organizationId, user.activeOrganizationId),
					),
				);

			const folderIds = folderRows.map((f) => f.id);

			if (folderIds.length > 0) {
				await db()
					.update(videos)
					.set({ folderId: null })
					.where(
						and(
							inArray(videos.id, validVideoIds),
							inArray(videos.folderId, folderIds),
						),
					);
			}
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
