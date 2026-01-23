"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import {
	folders,
	sharedVideos,
	spaceVideos,
	videos,
} from "@inflight/database/schema";
import type { Folder, Space, Video } from "@inflight/web-domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeVideosFromFolder(
	folderId: Folder.FolderId,
	videoIds: Video.VideoId[],
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

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

		// Clear the folderId on the videos
		await db()
			.update(videos)
			.set({ folderId: null, updatedAt: new Date() })
			.where(
				and(inArray(videos.id, validVideoIds), eq(videos.folderId, folderId)),
			);

		// Clear the folderId in the appropriate table based on context
		if (isAllSpacesEntry || !folder.spaceId) {
			// Organization-level folder - clear folderId in sharedVideos
			await db()
				.update(sharedVideos)
				.set({ folderId: null })
				.where(
					and(
						eq(sharedVideos.organizationId, user.activeOrganizationId),
						inArray(sharedVideos.videoId, validVideoIds),
						eq(sharedVideos.folderId, folderId),
					),
				);
		} else if (folder.spaceId) {
			// Space-level folder - clear folderId in spaceVideos
			await db()
				.update(spaceVideos)
				.set({ folderId: null })
				.where(
					and(
						sql`${spaceVideos.spaceId} = ${folder.spaceId}`,
						inArray(spaceVideos.videoId, validVideoIds),
						eq(spaceVideos.folderId, folderId),
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
			message: `${validVideoIds.length} video${validVideoIds.length === 1 ? "" : "s"} removed from folder`,
			removedCount: validVideoIds.length,
		};
	} catch (error) {
		console.error("Error removing videos from folder:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to remove videos from folder",
		};
	}
}
