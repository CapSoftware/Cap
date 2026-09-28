import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "./media-client";
import { runPromise } from "./server";
import { decodeStorageVideo } from "./video-storage";

/**
 * Older recordings were stored without a duration, which the editor needs.
 * Measures it from the video file once and saves it, so they open like any
 * other recording.
 */
export async function measureMissingVideoDuration(videoId: Video.VideoId) {
	if (!isMediaServerConfigured()) return null;
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video) return null;
	if (video.duration && video.duration > 0) return video.duration;
	try {
		const url = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);
			return yield* bucket.getInternalSignedObjectUrl(
				`${video.ownerId}/${video.id}/result.mp4`,
				{ expiresIn: 5 * 60 },
			);
		}).pipe(runPromise);
		const probe = await probeVideoViaMediaServer(url, { maxRetries: 0 });
		if (!Number.isFinite(probe.duration) || probe.duration <= 0) return null;
		await db()
			.update(videos)
			.set({
				duration: probe.duration,
				width: video.width ?? probe.width,
				height: video.height ?? probe.height,
				fps: video.fps ?? Math.round(probe.fps),
			})
			.where(eq(videos.id, video.id));
		return probe.duration;
	} catch (error) {
		console.warn("Could not measure the video duration", videoId, error);
		return null;
	}
}
