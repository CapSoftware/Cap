"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	videos,
} from "@cap/database/schema";
import type { Organisation, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";

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
		let memberRole: string | null = null;

		if (!isOrgOwner) {
			const orgMembership = await db()
				.select({ id: organizationMembers.id, role: organizationMembers.role })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.userId, user.id),
						eq(organizationMembers.organizationId, organizationId),
					),
				)
				.limit(1);
			hasAccess = orgMembership.length > 0;
			memberRole = orgMembership[0]?.role ?? null;
		}

		if (!hasAccess) {
			throw new Error(
				"You don't have permission to remove videos from this organization",
			);
		}

		const canRemoveAnyVideo = canManageOrganizationSettings(
			getEffectiveOrganizationRole({
				userId: user.id,
				ownerId: organization.ownerId,
				memberRole,
			}),
		);

		// Only allow removing videos that are currently shared with the organization
		const existingSharedVideos = await db()
			.select({ videoId: sharedVideos.videoId, ownerId: videos.ownerId })
			.from(sharedVideos)
			.leftJoin(videos, eq(videos.id, sharedVideos.videoId))
			.where(
				and(
					eq(sharedVideos.organizationId, organizationId),
					inArray(sharedVideos.videoId, videoIds),
				),
			);

		const existingVideoIds = existingSharedVideos
			.filter((sv) => canRemoveAnyVideo || sv.ownerId === user.id)
			.map((sv) => sv.videoId);

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
