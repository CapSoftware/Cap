import { InternalError, Video } from "@cap/web-domain";
import { Effect } from "effect";

import { provideOptionalAuth } from "../Auth.ts";
import { Videos } from "./index.ts";

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

			GetUploadProgress: (videoId) =>
				videos.getUploadProgress(videoId).pipe(
					provideOptionalAuth,
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						UnknownException: () => new InternalError({ type: "unknown" }),
					}),
				),

			VideoGetDownloadInfo: (videoId) =>
				videos.getDownloadInfo(videoId).pipe(
					provideOptionalAuth,
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						UnknownException: () => new InternalError({ type: "unknown" }),
						S3Error: () => new InternalError({ type: "s3" }),
					}),
				),
		};
	}),
);
