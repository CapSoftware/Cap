"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, spaceVideos } from "@cap/database/schema";
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

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		// `spaceId` is caller-supplied. `activeOrganizationId` is read from the
		// user record so the all-spaces branch is already scoped to them, but the
		// space branch would otherwise expose folder contents of any space.
		if (!isAllSpacesEntry) {
			const access = await getSpaceAccess(user.id, spaceId);
			if (!access || (!access.organizationRole && !access.spaceRole)) {
				throw new Error("Folder not found");
			}
		}

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
