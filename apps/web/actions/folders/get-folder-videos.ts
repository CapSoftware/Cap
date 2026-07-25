"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, spaceVideos } from "@cap/database/schema";
import type { Folder, Space, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
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

		if (!spaceId) {
			throw new Error("Space ID is required");
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		// `spaceId` is caller-supplied, so the space branch needs a membership
		// check. The all-spaces branch compares against `activeOrganizationId`,
		// which is read from the user record, so it is already scoped.
		//
		// The membership check alone is not sufficient: `folderId` is also
		// caller-supplied, so the queries below must be constrained to the space
		// (or org) we just authorized. Otherwise a caller could pass a space they
		// legitimately belong to together with a folder from another space and
		// still read its contents.
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
					.where(
						and(
							eq(sharedVideos.folderId, folderId),
							eq(sharedVideos.organizationId, user.activeOrganizationId),
						),
					)
			: await db()
					.select({ id: spaceVideos.videoId })
					.from(spaceVideos)
					.where(
						and(
							eq(spaceVideos.folderId, folderId),
							eq(spaceVideos.spaceId, spaceId),
						),
					);

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
