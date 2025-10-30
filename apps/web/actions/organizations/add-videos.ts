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
import type { Organisation, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToOrganization(
	organizationId: Organisation.OrganisationId,
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

		// Update existing videos to move them to root (clear folderId)
		if (existingVideoIds.length > 0) {
			await db()
				.update(sharedVideos)
				.set({ folderId: null })
				.where(
					and(
						eq(sharedVideos.organizationId, organizationId),
						inArray(sharedVideos.videoId, existingVideoIds),
					),
				);
		}

		// Insert new videos
		if (newVideoIds.length > 0) {
			const sharedVideoEntries = newVideoIds.map((videoId) => ({
				id: nanoId(),
				videoId,
				organizationId,
				sharedByUserId: user.id,
			}));

			await db().insert(sharedVideos).values(sharedVideoEntries);
		}

		revalidatePath(`/dashboard/spaces/${organizationId}`);
		revalidatePath("/dashboard/caps");

		const totalUpdated = existingVideoIds.length + newVideoIds.length;
		return {
			success: true,
			message: `${totalUpdated} video${
				totalUpdated === 1 ? "" : "s"
			} ${totalUpdated === 1 ? "is" : "are"} now in organization root`,
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
