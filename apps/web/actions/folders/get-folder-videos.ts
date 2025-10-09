"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, spaceVideos } from "@cap/database/schema";
import type { Folder, Space, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

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
