"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders, sharedVideos, spaceVideos } from "@cap/database/schema";
import type { Folder, Space, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { getSpaceAccess } from "@/actions/organization/space-authorization";

export async function getFolderVideoIds(
	folderId: Folder.FolderId,
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!folderId) {
			throw new Error("Folder ID is required");
		}

		// Ensure the caller can see this folder before disclosing its contents.
		const [folder] = await db()
			.select({
				spaceId: folders.spaceId,
				organizationId: folders.organizationId,
				createdById: folders.createdById,
			})
			.from(folders)
			.where(eq(folders.id, folderId));

		if (!folder) {
			throw new Error("Folder not found");
		}

		if (folder.spaceId === null) {
			// Personal folders are creator-only (mirrors FoldersPolicy.canEdit and
			// add-videos.ts); org membership must NOT grant access to another user's
			// personal folder.
			if (folder.createdById !== user.id) {
				throw new Error("Folder not found");
			}
		} else {
			// getSpaceAccess returns a non-null object even for non-members (with
			// both roles null), so a bare `!access` check would NOT block them.
			// Require an actual org or space role to view the folder's contents.
			const access = await getSpaceAccess(user.id, folder.spaceId);
			if (
				!access ||
				(access.organizationRole === null && access.spaceRole === null)
			) {
				throw new Error("Folder not found");
			}
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		const rows = isAllSpacesEntry
			? await db()
					.select({ id: sharedVideos.videoId })
					.from(sharedVideos)
					.where(eq(sharedVideos.folderId, folderId))
			: await db()
					.select({ id: spaceVideos.videoId })
					.from(spaceVideos)
					.where(eq(spaceVideos.folderId, folderId));

		return {
			success: true,
			data: rows.map((r) => r.id as Video.VideoId),
		};
	} catch (error) {
		console.error("Error fetching folder video IDs:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch folder videos",
		};
	}
}
