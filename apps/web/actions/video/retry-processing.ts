"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export async function retryVideoProcessing({
	videoId,
}: {
	videoId: Video.VideoId;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Unauthorized");

	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));

	if (!upload) throw new Error("No upload record found");
	if (!upload.rawFileKey) throw new Error("No raw file key found for retry");

	await startVideoProcessingWorkflow({
		videoId,
		userId: user.id,
		rawFileKey: upload.rawFileKey,
		bucketId: video.bucket ?? null,
		processingMessage: "Retrying video processing...",
		startFailureMessage: "Video processing could not restart.",
	});

	return { success: true };
}
