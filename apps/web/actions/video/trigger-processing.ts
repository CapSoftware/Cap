"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { startVideoProcessingDirect } from "@/lib/video-processing";

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

	await startVideoProcessingDirect({
		videoId,
		userId: user.id,
		rawFileKey,
		bucketId,
		processingMessage: "Starting video processing...",
		startFailureMessage: "Video processing could not start.",
	});

	return { success: true };
}
