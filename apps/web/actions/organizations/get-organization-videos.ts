"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { getOrganizationAccess } from "@/actions/organization/authorization";

export async function getOrganizationVideoIds(
	organizationId: Organisation.OrganisationId,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!organizationId) {
			throw new Error("Organization ID is required");
		}

		// Only members/owner of the organization may see its shared videos.
		const access = await getOrganizationAccess(user.id, organizationId);
		if (!access) {
			throw new Error("Organization not found");
		}

		const videoIds = await db()
			.select({
				videoId: sharedVideos.videoId,
			})
			.from(sharedVideos)
			.where(
				and(
					eq(sharedVideos.organizationId, organizationId),
					isNull(sharedVideos.folderId),
				),
			);

		return {
			success: true,
			data: videoIds.map((v) => v.videoId),
		};
	} catch (error) {
		console.error("Error fetching organization video IDs:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch organization videos",
		};
	}
}
