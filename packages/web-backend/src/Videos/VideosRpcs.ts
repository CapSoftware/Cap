import { InternalError, Video } from "@cap/web-domain";
import { Effect } from "effect";

import { Videos } from ".";

export const VideosRpcsLive = Video.VideoRpcs.toLayer(
	Effect.gen(function* () {
		const videos = yield* Videos;

		return {
			VideoDelete: (videoId) =>
				videos.delete(videoId).pipe(
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						S3Error: () => new InternalError({ type: "s3" }),
					}),
				),
			VideoDuplicate: (videoId) =>
				videos.duplicate(videoId).pipe(
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						S3Error: () => new InternalError({ type: "s3" }),
					}),
				),
		};
	}),
);
