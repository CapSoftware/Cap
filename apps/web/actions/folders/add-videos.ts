"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	folders,
	sharedVideos,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Folder, Space, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";

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
			.select({
				id: folders.id,
				organizationId: folders.organizationId,
				spaceId: folders.spaceId,
			})
			.from(folders)
			.where(and(eq(folders.id, folderId), eq(folders.spaceId, spaceId)));

		if (!folder) {
			throw new Error("Folder not found");
		}

		if (spaceId === user.activeOrganizationId) {
			const access = await getOrganizationAccess(
				user.id,
				user.activeOrganizationId,
			);
			if (!access || folder.organizationId !== user.activeOrganizationId) {
				throw new Error("Folder not found");
			}
		} else {
			const access = await getSpaceAccess(user.id, spaceId);
			if (
				!access ||
				access.organizationId !== folder.organizationId ||
				!access.organizationRole ||
				(!access.canManage && !access.spaceRole)
			) {
				throw new Error("Folder not found");
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

		const isAllSpacesEntry = spaceId === user.activeOrganizationId;
		const sharesWithOrganization = isAllSpacesEntry && !!folder.spaceId;
		const sharingTable = sharesWithOrganization ? sharedVideos : spaceVideos;
		const existingShares = await db()
			.select({ videoId: sharingTable.videoId })
			.from(sharingTable)
			.where(
				and(
					sharesWithOrganization
						? eq(sharedVideos.organizationId, user.activeOrganizationId)
						: eq(spaceVideos.spaceId, spaceId),
					inArray(sharingTable.videoId, validVideoIds),
				),
			);
		const existingVideoIds = new Set(
			existingShares.map((share) => share.videoId),
		);
		const newVideoIds = validVideoIds.filter((id) => !existingVideoIds.has(id));

		if (newVideoIds.length > 0 && sharesWithOrganization) {
			await db()
				.insert(sharedVideos)
				.values(
					newVideoIds.map((videoId) => {
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
		} else if (newVideoIds.length > 0) {
			await db()
				.insert(spaceVideos)
				.values(
					newVideoIds.map((videoId) => {
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
