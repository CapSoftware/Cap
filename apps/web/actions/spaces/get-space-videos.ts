"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaceVideos } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function getSpaceVideoIds(spaceId: string) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!spaceId) {
			throw new Error("Space ID is required");
		}

		const videoIds = await db()
			.select({
				videoId: spaceVideos.videoId,
			})
			.from(spaceVideos)
			.where(eq(spaceVideos.spaceId, spaceId));

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
