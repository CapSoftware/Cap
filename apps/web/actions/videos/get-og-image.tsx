import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import { findScreenshotObjectKey, Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { extractPosterFrameDataUri } from "@/lib/og/poster-frame";
import { renderVideoOg } from "@/lib/og/video-og";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function generateVideoOgImage(videoId: Video.VideoId) {
	const videoData = await getData(videoId);

	if (!videoData) return renderVideoOg({ kind: "not-found" });

	const { video, ownerName } = videoData;

	if (video.password) return renderVideoOg({ kind: "password" });
	if (video.public === false) return renderVideoOg({ kind: "locked" });

	let screenshotUrl: string | undefined;

	try {
		await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);
			const listResponse = yield* bucket.listObjects({
				prefix: `${video.ownerId}/${video.id}/`,
			});
			const screenshotKey = findScreenshotObjectKey(
				listResponse.Contents || [],
			);

			if (!screenshotKey) return;
			screenshotUrl = yield* bucket.getSignedObjectUrl(screenshotKey);
		}).pipe(runPromise);
	} catch (error) {
		console.error("Error generating URL for screenshot:", error);
	}

	// The media pipeline writes the screenshot asynchronously — fall back to
	// grabbing a frame from the playable source so fresh uploads still get a
	// real thumbnail.
	if (!screenshotUrl) {
		screenshotUrl = await extractPosterFrameDataUri(video.id).catch(
			() => undefined,
		);
	}

	return renderVideoOg({
		kind: "video",
		video: {
			title: video.name,
			ownerName: ownerName ?? undefined,
			duration: video.duration ?? undefined,
			screenshotUrl,
		},
	});
}

async function getData(videoId: Video.VideoId) {
	const query = await db()
		.select({ video: videos, ownerName: users.name })
		.from(videos)
		.leftJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId));

	const result = query[0];

	if (!result) return;

	return result;
}
