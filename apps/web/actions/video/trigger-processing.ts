"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { processVideoWorkflow } from "@/workflows/process-video";

export async function triggerVideoProcessing({
	videoId,
	rawFileKey,
	bucketId,
}: {
	videoId: Video.VideoId;
	rawFileKey: string;
	bucketId: string | null;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Unauthorized");

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video processing...",
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId));

	await start(processVideoWorkflow, [
		{
			videoId,
			userId: user.id,
			rawFileKey,
			bucketId,
		},
	]);

	return { success: true };
}
