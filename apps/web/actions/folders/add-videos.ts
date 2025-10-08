"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { folders, spaceVideos, videos } from "@cap/database/schema";
import type { Folder, Space, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToFolder(
	folderId: Folder.FolderId,
	videoIds: Video.VideoId[],
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

		// If this folder belongs to a space, ensure spaceVideos entry exists and set folderId in that relation
		if (folder.spaceId) {
			// Find existing relations
			const existingRelations = await db()
				.select({ videoId: spaceVideos.videoId })
				.from(spaceVideos)
				.where(
					and(
						eq(
							spaceVideos.spaceId,
							folder.spaceId as Space.SpaceIdOrOrganisationId,
						),
						inArray(spaceVideos.videoId, validVideoIds),
					),
				);

			const existingIds = new Set(existingRelations.map((r) => r.videoId));
			const toInsert = validVideoIds.filter((id) => !existingIds.has(id));

			if (toInsert.length > 0) {
				const spaceIdValue = folder.spaceId as Space.SpaceIdOrOrganisationId;
				await db()
					.insert(spaceVideos)
					.values(
						toInsert.map((id) => ({
							id: nanoId(),
							videoId: id,
							spaceId: spaceIdValue,
							addedById: user.id,
							folderId,
						})),
					);
			}

			// Update folderId for all valid videos in this space
			await db()
				.update(spaceVideos)
				.set({ folderId })
				.where(
					and(
						eq(
							spaceVideos.spaceId,
							folder.spaceId as Space.SpaceIdOrOrganisationId,
						),
						inArray(spaceVideos.videoId, validVideoIds),
					),
				);
		}

		// Revalidate relevant paths
		revalidatePath(`/dashboard/caps`);
		revalidatePath(`/dashboard/folder/${folderId}`);
		if (folder.spaceId) {
			revalidatePath(`/dashboard/spaces/${folder.spaceId}/folder/${folderId}`);
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
