import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { isStorageObjectNotFound } from "@/lib/storage-not-found";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export async function cleanupLoomFileSource({
	videoId,
	userId,
	rawFileKey,
}: {
	videoId: string;
	userId: string;
	rawFileKey: string;
}): Promise<void> {
	"use step";

	const outputKey = `${userId}/${videoId}/result.mp4`;
	if (
		rawFileKey === outputKey ||
		!rawFileKey.startsWith(`${userId}/${videoId}/`)
	) {
		return;
	}
	try {
		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)));
		if (!video || video.ownerId !== userId) return;
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);
		const output = await bucket.headObject(outputKey).pipe(
			Effect.catchIf(isStorageObjectNotFound, () => Effect.succeed(null)),
			runWorkflowPromise,
		);
		if (!output?.ContentLength || output.ContentLength <= 0) return;
		await bucket.deleteObject(rawFileKey).pipe(runWorkflowPromise);
	} catch (error) {
		console.warn("[loom-file] Failed to clean up the processed source", error);
	}
}
