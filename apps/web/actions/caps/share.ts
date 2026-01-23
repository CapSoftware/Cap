"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { nanoId } from "@inflight/database/helpers";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	videos,
} from "@inflight/database/schema";
import type { Organisation, Space, Video } from "@inflight/web-domain";
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

		for (const sharedOrganization of currentSharedOrganizations) {
			if (!organizationIds.includes(sharedOrganization.organizationId)) {
				await db()
					.delete(sharedVideos)
					.where(
						and(
							eq(sharedVideos.videoId, capId),
							eq(
								sharedVideos.organizationId,
								sharedOrganization.organizationId,
							),
						),
					);
			}
		}

		for (const organizationId of organizationIds) {
			const existingShare = currentSharedOrganizations.find(
				(share) => share.organizationId === organizationId,
			);
			if (!existingShare) {
				await db().insert(sharedVideos).values({
					id: nanoId(),
					videoId: capId,
					organizationId: organizationId,
					sharedByUserId: user.id,
				});
			}
		}

		const spacesIds = spacesData.map((space) => space.id);

		const currentSpaceVideos = await db()
			.select()
			.from(spaceVideos)
			.where(eq(spaceVideos.videoId, capId));

		for (const spaceVideo of currentSpaceVideos) {
			if (!spacesIds.includes(spaceVideo.spaceId)) {
				await db()
					.delete(spaceVideos)
					.where(
						and(
							eq(spaceVideos.videoId, capId),
							eq(spaceVideos.spaceId, spaceVideo.spaceId),
						),
					);
			}
		}

		for (const spaceId of spacesIds) {
			const existingSpaceShare = currentSpaceVideos.find(
				(share) => share.spaceId === spaceId,
			);
			if (!existingSpaceShare) {
				await db().insert(spaceVideos).values({
					id: nanoId(),
					videoId: capId,
					spaceId: spaceId,
					addedById: user.id,
				});
			}
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
