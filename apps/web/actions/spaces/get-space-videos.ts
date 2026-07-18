"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, spaceVideos } from "@cap/database/schema";
import type { Space } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";

export async function getSpaceVideoIds(spaceId: Space.SpaceIdOrOrganisationId) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!spaceId) {
			throw new Error("Space ID is required");
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		// Only members/owner of the space (or organization) may see its videos.
		if (isAllSpacesEntry) {
			const access = await getOrganizationAccess(user.id, spaceId);
			if (!access) {
				throw new Error("Space not found");
			}
		} else {
			// getSpaceAccess returns a non-null object even for non-members (with
			// both roles null), so a bare `!access` check would NOT block them.
			// Require an actual org or space role to view the space's videos.
			const access = await getSpaceAccess(user.id, spaceId);
			if (
				!access ||
				(access.organizationRole === null && access.spaceRole === null)
			) {
				throw new Error("Space not found");
			}
		}

		const videoIds = isAllSpacesEntry
			? await db()
					.select({
						videoId: sharedVideos.videoId,
					})
					.from(sharedVideos)
					.where(
						and(
							eq(sharedVideos.organizationId, spaceId),
							isNull(sharedVideos.folderId),
						),
					)
			: await db()
					.select({
						videoId: spaceVideos.videoId,
					})
					.from(spaceVideos)
					.where(
						and(eq(spaceVideos.spaceId, spaceId), isNull(spaceVideos.folderId)),
					);

		return {
			success: true,
			data: videoIds.map((v) => v.videoId),
		};
	} catch (error) {
		console.error("Error fetching space video IDs:", error);
		return {
			success: false,
			error:
				error instanceof Error ? error.message : "Failed to fetch space videos",
		};
	}
}
