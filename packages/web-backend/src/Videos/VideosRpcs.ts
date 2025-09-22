import { InternalError, Video } from "@cap/web-domain";
import { Effect } from "effect";
import { provideOptionalAuth } from "../Auth";
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
						UnknownException: () => new InternalError({ type: "unknown" }),
					}),
				),
			VideoDuplicate: (videoId) =>
				videos.duplicate(videoId).pipe(
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						S3Error: () => new InternalError({ type: "s3" }),
						UnknownException: () => new InternalError({ type: "unknown" }),
					}),
				),
			GetUploadProgress: (videoId) =>
				videos.getUploadProgress(videoId).pipe(
					provideOptionalAuth,
					(v) => v,
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						UnknownException: () => new InternalError({ type: "unknown" }),
					}),
				),
		};
	}),
);
