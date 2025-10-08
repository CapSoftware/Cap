"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders, spaceVideos, videos } from "@cap/database/schema";
import type { Folder, Space, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToFolder(
	folderId: Folder.FolderId,
	videoIds: Video.VideoId[],
	spaceId?: string,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!folderId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		// Verify folder exists and is accessible
		const [folder] = await db()
			.select({ id: folders.id, spaceId: folders.spaceId })
			.from(folders)
			.where(eq(folders.id, folderId));

		if (!folder) {
			throw new Error("Folder not found");
		}

		// Only allow updating videos the user owns
		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

		// Update the video's folderId
		await db()
			.update(videos)
			.set({ folderId: folderId, updatedAt: new Date() })
			.where(inArray(videos.id, validVideoIds));

		// If this folder belongs to a space and we have a spaceId context, update spaceVideos relation
		const effectiveSpaceId = spaceId || folder.spaceId;
		if (effectiveSpaceId) {
			// Update folderId for videos that are already in this space
			await db()
				.update(spaceVideos)
				.set({ folderId })
				.where(
					and(
						eq(
							spaceVideos.spaceId,
							effectiveSpaceId as Space.SpaceIdOrOrganisationId,
						),
						inArray(spaceVideos.videoId, validVideoIds),
					),
				);
		}

		// Revalidate relevant paths
		revalidatePath(`/dashboard/caps`);
		revalidatePath(`/dashboard/folder/${folderId}`);
		const effectiveSpaceIdForRevalidate = spaceId || folder.spaceId;
		if (effectiveSpaceIdForRevalidate) {
			revalidatePath(
				`/dashboard/spaces/${effectiveSpaceIdForRevalidate}/folder/${folderId}`,
			);
		}

		return {
			success: true,
			message: `${validVideoIds.length} video${validVideoIds.length === 1 ? "" : "s"} added to folder`,
			addedCount: validVideoIds.length,
		};
	} catch (error) {
		console.error("Error adding videos to folder:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add videos to folder",
		};
	}
}
