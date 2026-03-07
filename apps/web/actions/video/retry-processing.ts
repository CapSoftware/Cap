"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import {
	startVideoProcessingWorkflow,
	type VideoProcessingStartStatus,
} from "@/lib/video-processing";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const STALE_PROCESSING_START_MS = 90 * SECOND;
const STALE_PROCESSING_PROGRESS_MS = 10 * MINUTE;
const STALE_THUMBNAIL_MS = 5 * MINUTE;

const shouldForceRetryProcessing = (upload: {
	phase: string;
	updatedAt: Date;
	processingProgress: number;
}) => {
	const ageMs = Date.now() - upload.updatedAt.getTime();

	if (upload.phase === "processing") {
		if (upload.processingProgress === 0 && ageMs > STALE_PROCESSING_START_MS) {
			return true;
		}

		return ageMs > STALE_PROCESSING_PROGRESS_MS;
	}

	if (upload.phase === "generating_thumbnail") {
		return ageMs > STALE_THUMBNAIL_MS;
	}

	return false;
};

export async function retryVideoProcessing({
	videoId,
}: {
	videoId: Video.VideoId;
}): Promise<{ success: boolean; status: VideoProcessingStartStatus }> {
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

	const status = await startVideoProcessingWorkflow({
		videoId,
		userId: user.id,
		rawFileKey: upload.rawFileKey,
		bucketId: video.bucket ?? null,
		processingMessage: "Retrying video processing...",
		startFailureMessage: "Video processing could not restart.",
		forceRestart: shouldForceRetryProcessing(upload),
	});

	return { success: true, status };
}
