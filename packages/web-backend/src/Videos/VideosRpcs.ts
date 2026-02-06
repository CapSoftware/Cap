import { InternalError, Policy, Video } from "@cap/web-domain";
import { Effect, Exit, Schema, Unify } from "effect";

import { provideOptionalAuth } from "../Auth.ts";
import { Videos } from "./index.ts";

export const VideosRpcsLive = Video.VideoRpcs.toLayer(
	Effect.gen(function* () {
		const videos = yield* Videos;

		return {
			VideoDelete: (videoId) =>
				videos.delete(videoId).pipe(
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
				),

			VideoDuplicate: (videoId) =>
				videos.duplicate(videoId).pipe(
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
				),

			GetUploadProgress: (videoId) =>
				videos.getUploadProgress(videoId).pipe(
					provideOptionalAuth,
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag(
						"UnknownException",
						() => new InternalError({ type: "unknown" }),
					),
				),

			VideoInstantCreate: (input) =>
				videos.createInstantRecording(input).pipe(
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
				),

			VideoStudioCreate: (input) =>
				videos.createStudioRecording(input).pipe(
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
				),

			VideoUploadProgressUpdate: (input) =>
				videos
					.updateUploadProgress(input)
					.pipe(
						Effect.catchTag(
							"DatabaseError",
							() => new InternalError({ type: "database" }),
						),
					),

			VideoGetDownloadInfo: (videoId) =>
				videos.getDownloadInfo(videoId).pipe(
					provideOptionalAuth,
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag(
						"UnknownException",
						() => new InternalError({ type: "unknown" }),
					),
					Effect.catchTag("S3Error", () => new InternalError({ type: "s3" })),
				),

			VideosGetThumbnails: (videoIds) =>
				Effect.all(
					videoIds.map((id) =>
						videos.getThumbnailURL(id).pipe(
							Effect.catchTag(
								"DatabaseError",
								() => new InternalError({ type: "database" }),
							),
							Effect.catchTag(
								"S3Error",
								() => new InternalError({ type: "s3" }),
							),
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
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag(
						"UnknownException",
						() => new InternalError({ type: "unknown" }),
					),
				),

			VideosGetAnalytics: (videoIds) =>
				videos.getAnalyticsBulk(videoIds).pipe(
					Effect.map(
						(results) =>
							results.map((result) =>
								Exit.mapError(
									Exit.map(result, (v) => ({ count: v.count }) as const),
									(error) => {
										if (Schema.is(Video.NotFoundError)(error)) return error;
										if (Schema.is(Policy.PolicyDeniedError)(error))
											return error;
										if (Schema.is(Video.VerifyVideoPasswordError)(error))
											return error;
										return error as
											| Video.NotFoundError
											| Policy.PolicyDeniedError
											| Video.VerifyVideoPasswordError;
									},
								),
							) as readonly Exit.Exit<
								{ readonly count: number },
								| Video.NotFoundError
								| Policy.PolicyDeniedError
								| Video.VerifyVideoPasswordError
							>[],
					),
					provideOptionalAuth,
					Effect.catchTag(
						"DatabaseError",
						() => new InternalError({ type: "database" }),
					),
					Effect.catchTag(
						"UnknownException",
						() => new InternalError({ type: "unknown" }),
					),
				),
		};
	}),
);
