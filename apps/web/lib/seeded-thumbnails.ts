import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import type { SeededThumbnails } from "@/components/VideoThumbnail";
import { runPromise } from "@/lib/server";

// Matches the VideosGetThumbnails batch limit. Pages take a `limit` query
// parameter, so ids past this fall back to the client RPC.
const MAX_SEEDED_THUMBNAILS = 50;

export function seedThumbnailUrls(
	user: Parameters<typeof makeCurrentUserLayer>[0],
	allVideoIds: readonly Video.VideoId[],
): SeededThumbnails | undefined {
	const videoIds = allVideoIds.slice(0, MAX_SEEDED_THUMBNAILS);
	if (videoIds.length === 0) return undefined;

	const urls = Effect.gen(function* () {
		const videos = yield* Videos;
		const results = yield* Effect.forEach(
			videoIds,
			(videoId) => videos.getThumbnailURL(videoId).pipe(Effect.option),
			{ concurrency: 10 },
		);

		const seeded: Record<string, string> = {};
		results.forEach((result, index) => {
			const url = Option.flatten(result);
			const videoId = videoIds[index];
			if (videoId && Option.isSome(url)) seeded[videoId] = url.value;
		});
		return seeded;
	}).pipe(Effect.provide(makeCurrentUserLayer(user)), runPromise);

	return {
		videoIds,
		urls: urls.catch(() => ({})),
	};
}
