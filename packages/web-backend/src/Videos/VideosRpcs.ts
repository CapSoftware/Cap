import { InternalError, Video } from "@cap/web-domain";
import { Effect, Exit, Schema, Unify } from "effect";

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

			VideosGetThumbnails: (videoIds) =>
				Effect.all(
					videoIds.map((id) =>
						videos.getThumbnailURL(id).pipe(
							Effect.catchTags({
								DatabaseError: () => new InternalError({ type: "database" }),
								S3Error: () => new InternalError({ type: "s3" }),
							}),
							Effect.matchEffect({
								onSuccess: (v) => Effect.succeed(Exit.succeed(v)),
								onFailure: (e) =>
									Schema.is(InternalError)(e)
										? Effect.fail(e)
										: Effect.succeed(Exit.fail(e)),
							}),
							Effect.map((v) => Unify.unify(v)),
						),
					),
					{ concurrency: 10 },
				).pipe(
					provideOptionalAuth,
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						UnknownException: () => new InternalError({ type: "unknown" }),
					}),
				),

			VideosGetAnalytics: (videoIds) =>
				Effect.all(
					videoIds.map((id) =>
						videos.getAnalytics(id).pipe(
							Effect.catchTags({
								DatabaseError: () => new InternalError({ type: "database" }),
								UnknownException: () => new InternalError({ type: "unknown" }),
							}),
							Effect.matchEffect({
								onSuccess: (v) => Effect.succeed(Exit.succeed(v)),
								onFailure: (e) =>
									Schema.is(InternalError)(e)
										? Effect.fail(e)
										: Effect.succeed(Exit.fail(e)),
							}),
							Effect.map((v) => Unify.unify(v)),
						),
					),
					{ concurrency: 10 },
				).pipe(
					provideOptionalAuth,
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						UnknownException: () => new InternalError({ type: "unknown" }),
					}),
				),

			VideoCaptureAnalytics: (videoId) =>
				videos.captureAnalytics(videoId).pipe(
					provideOptionalAuth,
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						RequestError: () => new InternalError({ type: "httpRequest" }),
						ResponseError: () => new InternalError({ type: "httpResponse" }),
						UnknownException: () => new InternalError({ type: "unknown" }),
					}),
				),
		};
	}),
);
