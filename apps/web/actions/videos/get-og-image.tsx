import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import {
	findScreenshotObjectKey,
	Storage,
	VideosPolicy,
} from "@cap/web-backend";
import {
	getCustomThumbnailKey,
	getCustomThumbnailVersion,
} from "@cap/web-backend/src/Storage/custom-thumbnail";
import { getPublishedRecordingThumbnailKey } from "@cap/web-backend/src/Storage/recording-output";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";
import { extractPosterFrameDataUri } from "@/lib/og/poster-frame";
import { renderVideoOg, renderVideoOgStatus } from "@/lib/og/video-og";
import { runPromise, runPromiseExit } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function generateVideoOgImage(
	videoId: Video.VideoId,
	requestedVersion: string | null = null,
) {
	const videoData = await getData(videoId);

	if (!videoData) return renderVideoOgStatus("not-found");

	const { video, ownerName } = videoData;

	if (video.password) return renderVideoOgStatus("password");
	if (video.public === false) return renderVideoOgStatus("locked");
	const access = await anonymousViewAccess(video);
	if (access !== "allowed") return renderVideoOgStatus(access);

	// A version only names an image that exists. Anything else goes to the
	// current URL, so made-up versions cannot each cost a fresh render.
	const currentVersion = getCustomThumbnailVersion(video.metadata);
	if (requestedVersion !== null && requestedVersion !== currentVersion) {
		const location = new URLSearchParams({ videoId });
		if (currentVersion) location.set("v", currentVersion);
		return new Response(null, {
			status: 307,
			headers: {
				Location: `/api/video/og?${location}`,
				"Cache-Control": "public, max-age=60",
			},
		});
	}

	let screenshotUrl: string | undefined;

	try {
		await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);
			const publishedThumbnail =
				getCustomThumbnailKey(video) ??
				getPublishedRecordingThumbnailKey(video);
			if (publishedThumbnail) {
				screenshotUrl = yield* bucket.getSignedObjectUrl(publishedThumbnail);
				return;
			}
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

// Link previews are cached publicly, so they only show what a signed-out
// viewer without a password could see.
async function anonymousViewAccess(video: typeof videos.$inferSelect) {
	const exit = await Effect.flatMap(VideosPolicy, (policy) =>
		policy.canViewLoaded(video, Option.fromNullable(video.password)),
	).pipe(
		Effect.provideService(Video.VideoPasswordAttachment, { passwords: [] }),
		runPromiseExit,
	);
	if (Exit.isSuccess(exit)) return "allowed" as const;
	const failure = Cause.failureOption(exit.cause);
	return Option.isSome(failure) &&
		failure.value._tag === "VerifyVideoPasswordError"
		? ("password" as const)
		: ("locked" as const);
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
