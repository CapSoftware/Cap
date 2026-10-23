"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Organisation, Space, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

interface ShareCapParams {
	capId: Video.VideoId;
	spaceIds: Space.SpaceIdOrOrganisationId[];
	public?: boolean;
}

export async function shareCap({
	capId,
	spaceIds,
	public: isPublic,
}: ShareCapParams) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return { success: false, error: "Unauthorized" };
		}

		const [cap] = await db().select().from(videos).where(eq(videos.id, capId));
		if (!cap || cap.ownerId !== user.id) {
			return { success: false, error: "Unauthorized" };
		}

		const userOrganizations = await db()
			.select({
				organizationId: organizationMembers.organizationId,
			})
			.from(organizationMembers)
			.where(eq(organizationMembers.userId, user.id));

		const userOrganizationIds = userOrganizations.map(
			(org) => org.organizationId,
		);

		const directOrgIds = await db()
			.select()
			.from(organizations)
			.where(
				and(
					inArray(organizations.id, spaceIds as Organisation.OrganisationId[]),
					inArray(organizations.id, userOrganizationIds),
				),
			)
			.then((orgs) => orgs.map((org) => org.id));

		const spacesData = await db()
			.select()
			.from(spaces)
			.where(
				and(
					inArray(spaces.id, spaceIds),
					inArray(spaces.organizationId, userOrganizationIds),
				),
			);

		const organizationIds = directOrgIds;

		const currentSharedOrganizations = await db()
			.select()
			.from(sharedVideos)
			.where(eq(sharedVideos.videoId, capId));

		const orgIdsToRemove = currentSharedOrganizations
			.filter((s) => !organizationIds.includes(s.organizationId))
			.map((s) => s.organizationId);
		if (orgIdsToRemove.length > 0) {
			await db()
				.delete(sharedVideos)
				.where(
					and(
						eq(sharedVideos.videoId, capId),
						inArray(sharedVideos.organizationId, orgIdsToRemove),
					),
				);
		}

		const existingOrgIds = new Set(
			currentSharedOrganizations.map((s) => s.organizationId),
		);
		const newOrgEntries = organizationIds
			.filter((id) => !existingOrgIds.has(id))
			.map((organizationId) => ({
				id: nanoId(),
				videoId: capId,
				organizationId,
				sharedByUserId: user.id,
			}));
		if (newOrgEntries.length > 0) {
			await db().insert(sharedVideos).values(newOrgEntries);
		}

		const spacesIds = spacesData.map((space) => space.id);

		const currentSpaceVideos = await db()
			.select()
			.from(spaceVideos)
			.where(eq(spaceVideos.videoId, capId));

		const spaceIdsToRemove = currentSpaceVideos
			.filter((s) => !spacesIds.includes(s.spaceId))
			.map((s) => s.spaceId);
		if (spaceIdsToRemove.length > 0) {
			await db()
				.delete(spaceVideos)
				.where(
					and(
						eq(spaceVideos.videoId, capId),
						inArray(spaceVideos.spaceId, spaceIdsToRemove),
					),
				);
		}

		const existingSpaceIds = new Set(currentSpaceVideos.map((s) => s.spaceId));
		const newSpaceEntries = spacesIds
			.filter((id) => !existingSpaceIds.has(id))
			.map((spaceId) => ({
				id: nanoId(),
				videoId: capId,
				spaceId,
				addedById: user.id,
			}));
		if (newSpaceEntries.length > 0) {
			await db().insert(spaceVideos).values(newSpaceEntries);
		}

		// Update public status if provided
		if (typeof isPublic === "boolean") {
			await db()
				.update(videos)
				.set({ public: isPublic })
				.where(eq(videos.id, capId));
		}

		revalidatePath("/dashboard/caps");
		revalidatePath(`/dashboard/caps/${capId}`);
		return { success: true };
	} catch (error) {
		console.error("Error sharing cap:", error);
		return { success: false, error: "Failed to update sharing settings" };
	}
}
