"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { createBucketProvider } from "@/utils/s3";

export async function downloadVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();

	if (!user || !videoId) {
		throw new Error("Missing required data for downloading video");
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
		throw new Error("You don't have permission to download this video");
	}

	try {
		const bucketProvider = await createBucketProvider();
		const videoKey = `${video.ownerId}/${videoId}/result.mp4`;

		const downloadUrl = await bucketProvider.getSignedObjectUrl(videoKey);

		return {
			success: true,
			downloadUrl,
			filename: `${video.name}.mp4`,
		};
	} catch (error) {
		console.error("Error generating download URL:", error);
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to generate download URL");
	}
}
