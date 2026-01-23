"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { nanoId } from "@inflight/database/helpers";
import {
	folders,
	sharedVideos,
	spaceVideos,
	videos,
} from "@inflight/database/schema";
import type { Folder, Space, Video } from "@inflight/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToFolder(
	folderId: Folder.FolderId,
	videoIds: Video.VideoId[],
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!folderId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		const [folder] = await db()
			.select({ id: folders.id, spaceId: folders.spaceId })
			.from(folders)
			.where(eq(folders.id, folderId));

		if (!folder) {
			throw new Error("Folder not found");
		}

		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

		const isAllSpacesEntry = spaceId === user.activeOrganizationId;

		//if we're adding videos to a folder from Caps page, then insert the videos into the folder
		if (isAllSpacesEntry && folder.spaceId) {
			await db()
				.insert(sharedVideos)
				.values(
					validVideoIds.map((videoId) => {
						const id = nanoId();
						return {
							id,
							videoId,
							folderId,
							organizationId: user.activeOrganizationId,
							sharedByUserId: user.id,
						};
					}),
				);
		} else {
			await db()
				.insert(spaceVideos)
				.values(
					validVideoIds.map((videoId) => {
						const id = nanoId();
						return {
							id,
							videoId,
							folderId,
							spaceId,
							addedById: user.id,
						};
					}),
				);
		}

		if (isAllSpacesEntry) {
			await db()
				.update(sharedVideos)
				.set({ folderId })
				.where(
					and(
						eq(sharedVideos.organizationId, user.activeOrganizationId),
						inArray(sharedVideos.videoId, validVideoIds),
					),
				);
		} else {
			await db()
				.update(spaceVideos)
				.set({ folderId })
				.where(
					and(
						eq(spaceVideos.spaceId, spaceId),
						inArray(spaceVideos.videoId, validVideoIds),
					),
				);
		}

		revalidatePath(`/dashboard/caps`);
		revalidatePath(`/dashboard/folder/${folderId}`);
		if (spaceId) {
			revalidatePath(`/dashboard/spaces/${spaceId}/folder/${folderId}`);
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
