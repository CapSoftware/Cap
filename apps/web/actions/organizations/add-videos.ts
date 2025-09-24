"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToOrganization(
	organizationId: string,
	videoIds: Video.VideoId[],
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!organizationId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		const [organization] = await db()
			.select()
			.from(organizations)
			.where(eq(organizations.id, organizationId));

		if (!organization) {
			throw new Error("Organization not found");
		}

		const isOrgOwner = organization.ownerId === user.id;
		let hasAccess = isOrgOwner;

		if (!isOrgOwner) {
			const orgMembership = await db()
				.select({ id: organizationMembers.id })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.userId, user.id),
						eq(organizationMembers.organizationId, organizationId),
					),
				)
				.limit(1);

			hasAccess = orgMembership.length > 0;
		}

		if (!hasAccess) {
			throw new Error(
				"You don't have permission to add videos to this organization",
			);
		}

		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

		const existingSharedVideos = await db()
			.select({ videoId: sharedVideos.videoId })
			.from(sharedVideos)
			.where(
				and(
					eq(sharedVideos.organizationId, organizationId),
					inArray(sharedVideos.videoId, validVideoIds),
				),
			);

		const existingVideoIds = existingSharedVideos.map((sv) => sv.videoId);
		const newVideoIds = validVideoIds.filter(
			(id) => !existingVideoIds.includes(id),
		);

		if (newVideoIds.length === 0) {
			return {
				success: true,
				message: "Videos already shared with organization",
			};
		}

		const sharedVideoEntries = newVideoIds.map((videoId) => ({
			id: nanoId(),
			videoId,
			organizationId,
			sharedByUserId: user.id,
		}));

		await db().insert(sharedVideos).values(sharedVideoEntries);

		// Clear folderId for videos added to organization so they appear in main view
		await db()
			.update(videos)
			.set({ folderId: null })
			.where(inArray(videos.id, newVideoIds));

		revalidatePath(`/dashboard/spaces/${organizationId}`);
		revalidatePath("/dashboard/caps");

		return {
			success: true,
			message: `${newVideoIds.length} video${
				newVideoIds.length === 1 ? "" : "s"
			} shared with organization`,
		};
	} catch (error) {
		console.error("Error adding videos to organization:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add videos to organization",
		};
	}
}
