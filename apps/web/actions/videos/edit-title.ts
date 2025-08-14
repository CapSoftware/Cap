"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function editTitle(videoId: string, title: string) {
	const user = await getCurrentUser();

	if (!user || !title || !videoId) {
		throw new Error("Missing required data for updating video title");
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
		await db()
			.update(videos)
			.set({ name: title })
			.where(eq(videos.id, videoId));

		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");
		revalidatePath(`/s/${videoId}`);

		return { success: true };
	} catch (error) {
		console.error("Error updating video title:", error);
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to update video title");
	}
}
