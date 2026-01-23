"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { videos } from "@inflight/database/schema";
import type { VideoMetadata } from "@inflight/database/types";
import type { Video } from "@inflight/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function editDate(videoId: Video.VideoId, date: string) {
	const user = await getCurrentUser();

	if (!user || !date || !videoId) {
		throw new Error("Missing required data for updating video date");
	}

	const userId = user.id;
	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	if (query.length === 0) {
		throw new Error("Video not found");
	}

	const video = query[0];
	if (!video) {
		throw new Error("Video not found");
	}

	if (video.ownerId !== userId) {
		throw new Error("You don't have permission to update this video");
	}

	try {
		const newDate = new Date(date);
		const currentDate = new Date();

		// Prevent future dates
		if (newDate > currentDate) {
			throw new Error("Cannot set a date in the future");
		}

		// Store the custom date in the metadata field
		const currentMetadata = (video.metadata as VideoMetadata) || {};
		const updatedMetadata: VideoMetadata = {
			...currentMetadata,
			customCreatedAt: newDate.toISOString(),
		};

		await db()
			.update(videos)
			.set({
				metadata: updatedMetadata,
			})
			.where(eq(videos.id, videoId));

		// Revalidate paths to update the UI
		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");

		return { success: true };
	} catch (error) {
		console.error("Error updating video date:", error);
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to update video date");
	}
}
