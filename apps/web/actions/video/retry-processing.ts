"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { processVideoWorkflow } from "@/workflows/process-video";

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

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Retrying video processing...",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId));

	await start(processVideoWorkflow, [
		{
			videoId,
			userId: user.id,
			rawFileKey: upload.rawFileKey,
			bucketId: video.bucket ?? null,
		},
	]);

	return { success: true };
}
