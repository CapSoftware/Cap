"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { spaces, spaceVideos, videos } from "@cap/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToSpace(spaceId: string, videoIds: string[]) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!spaceId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		const [space] = await db()
			.select()
			.from(spaces)
			.where(eq(spaces.id, spaceId));

		if (!space) {
			throw new Error("Space not found");
		}

		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

		const existingSpaceVideos = await db()
			.select({ videoId: spaceVideos.videoId })
			.from(spaceVideos)
			.where(
				and(
					eq(spaceVideos.spaceId, spaceId),
					inArray(spaceVideos.videoId, validVideoIds),
				),
			);

		const existingVideoIds = existingSpaceVideos.map((sv) => sv.videoId);
		const newVideoIds = validVideoIds.filter(
			(id) => !existingVideoIds.includes(id),
		);

		if (newVideoIds.length === 0) {
			return { success: true, message: "Videos already added to space" };
		}

		const spaceVideoEntries = newVideoIds.map((videoId) => ({
			id: nanoId(),
			videoId,
			spaceId,
			addedById: user.id,
		}));

		await db().insert(spaceVideos).values(spaceVideoEntries);

		revalidatePath(`/dashboard/spaces/${spaceId}`);
		revalidatePath("/dashboard/caps");

		return {
			success: true,
			message: `${newVideoIds.length} video${newVideoIds.length === 1 ? "" : "s"} added to space`,
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
