"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { nanoId } from "@inflight/database/helpers";
import { sharedVideos, spaceVideos, videos } from "@inflight/database/schema";
import type { Space, Video } from "@inflight/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToSpace(
	spaceId: Space.SpaceIdOrOrganisationId,
	videoIds: Video.VideoId[],
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!spaceId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

		if (isAllSpacesEntry) {
			const existingSharedVideos = await db()
				.select({ videoId: sharedVideos.videoId })
				.from(sharedVideos)
				.where(
					and(
						eq(sharedVideos.organizationId, spaceId),
						inArray(sharedVideos.videoId, validVideoIds),
					),
				);

			const existingVideoIds = existingSharedVideos.map((v) => v.videoId);
			const newVideoIds = validVideoIds.filter(
				(id) => !existingVideoIds.includes(id),
			);

			if (existingVideoIds.length > 0) {
				await db()
					.update(sharedVideos)
					.set({ folderId: null })
					.where(
						and(
							eq(sharedVideos.organizationId, spaceId),
							inArray(sharedVideos.videoId, existingVideoIds),
						),
					);
			}

			// Insert new videos
			if (newVideoIds.length > 0) {
				const sharedVideoEntries = newVideoIds.map((videoId) => ({
					id: nanoId(),
					videoId,
					organizationId: spaceId,
					sharedByUserId: user.id,
				}));
				await db().insert(sharedVideos).values(sharedVideoEntries);
			}
		} else {
			// Check which videos already exist in spaceVideos
			const existingSpaceVideos = await db()
				.select({ videoId: spaceVideos.videoId })
				.from(spaceVideos)
				.where(
					and(
						eq(spaceVideos.spaceId, spaceId),
						inArray(spaceVideos.videoId, validVideoIds),
					),
				);

			const existingVideoIds = existingSpaceVideos.map((v) => v.videoId);
			const newVideoIds = validVideoIds.filter(
				(id) => !existingVideoIds.includes(id),
			);

			if (existingVideoIds.length > 0) {
				await db()
					.update(spaceVideos)
					.set({ folderId: null })
					.where(
						and(
							eq(spaceVideos.spaceId, spaceId),
							inArray(spaceVideos.videoId, existingVideoIds),
						),
					);
			}

			if (newVideoIds.length > 0) {
				const spaceVideoEntries = newVideoIds.map((videoId) => ({
					id: nanoId(),
					videoId,
					spaceId,
					addedById: user.id,
				}));

				await db().insert(spaceVideos).values(spaceVideoEntries);
			}
		}

		revalidatePath(`/dashboard/spaces/${spaceId}`);
		revalidatePath("/dashboard/caps");

		return {
			success: true,
			message: `${validVideoIds.length} video${validVideoIds.length === 1 ? "" : "s"} added to ${isAllSpacesEntry ? "organization" : "space"}`,
		};
	} catch (error) {
		console.error("Error adding videos to space:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add videos to space",
		};
	}
}
