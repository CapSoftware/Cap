"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	folders,
	organizationMembers,
	organizations,
	sharedVideos,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { Organisation } from "@cap/web-domain";

export async function removeVideosFromOrganization(
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
				"You don't have permission to remove videos from this organization",
			);
		}

		// Only allow removing videos that are currently shared with the organization
		const existingSharedVideos = await db()
			.select({ videoId: sharedVideos.videoId })
			.from(sharedVideos)
			.where(
				and(
					eq(sharedVideos.organizationId, organizationId),
					inArray(sharedVideos.videoId, videoIds),
				),
			);

		const existingVideoIds = existingSharedVideos.map((sv) => sv.videoId);

		if (existingVideoIds.length === 0) {
			return {
				success: true,
				message: "No matching shared videos found in organization",
			};
		}

		await db()
			.delete(sharedVideos)
			.where(
				and(
					eq(sharedVideos.organizationId, organizationId),
					inArray(sharedVideos.videoId, existingVideoIds),
				),
			);

		// Clear folderId for videos that are being removed from the organization and are currently in folders within that organization
		// First, get all folder IDs that belong to this organization
		const organizationFolders = await db()
			.select({ id: folders.id })
			.from(folders)
			.where(eq(folders.organizationId, organizationId));

		const organizationFolderIds = organizationFolders.map((f) => f.id);

		if (organizationFolderIds.length > 0) {
			await db()
				.update(videos)
				.set({ folderId: null })
				.where(
					and(
						inArray(videos.id, existingVideoIds),
						inArray(videos.folderId, organizationFolderIds),
					),
				);
		}

		revalidatePath(`/dashboard/spaces/${organizationId}`);
		revalidatePath("/dashboard/caps");

		return {
			success: true,
			message: `${existingVideoIds.length} video${
				existingVideoIds.length === 1 ? "" : "s"
			} removed from organization`,
		};
	} catch (error) {
		console.error("Error removing videos from organization:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to remove videos from organization",
		};
	}
}
