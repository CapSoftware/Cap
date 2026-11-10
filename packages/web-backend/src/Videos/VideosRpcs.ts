import { CurrentUser, InternalError, Policy, Video } from "@cap/web-domain";
import { Effect, Exit, type Option, Schema } from "effect";

import { provideOptionalAuth } from "../Auth.ts";
import { Videos } from "./index.ts";
import { VideoDownloadGate } from "./VideoDownloadGate.ts";

export const VideosRpcsLive = Video.VideoRpcs.toLayer(
	Effect.gen(function* () {
		const videos = yield* Videos;
		const downloadGate = yield* VideoDownloadGate;

		return {
			VideoDelete: (videoId) =>
				videos.delete(videoId).pipe(
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new InternalError({ type: "database" })),
					),
					Effect.catchTag("StorageError", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
					),
				),

			VideoDuplicate: (videoId) =>
				videos.duplicate(videoId).pipe(
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new InternalError({ type: "database" })),
					),
					Effect.catchTag("StorageError", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
					),
				),

			GetUploadProgress: (videoId) =>
				videos.getUploadProgress(videoId).pipe(
					provideOptionalAuth,
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new InternalError({ type: "database" })),
					),
					Effect.catchTag("UnknownException", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
					),
				),

			VideoInstantCreate: (input) =>
				videos.createInstantRecording(input).pipe(
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new InternalError({ type: "database" })),
					),
					Effect.catchTag("StorageError", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
					),
				),

			VideoUploadProgressUpdate: (input) =>
				videos
					.updateUploadProgress(input)
					.pipe(
						Effect.catchTag("DatabaseError", () =>
							Effect.fail(new InternalError({ type: "database" })),
						),
					),

			VideoGetDownloadInfo: (videoId) =>
				Effect.gen(function* () {
					const viewer = yield* Effect.serviceOption(CurrentUser);
					const access = yield* downloadGate.access(videoId, viewer);
					if (access === "denied") {
						return yield* Effect.fail(new Policy.PolicyDeniedError());
					}
					return yield* videos.getDownloadInfo(videoId, {
						publishedOnly: access === "viewer",
					});
				}).pipe(
					provideOptionalAuth,
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new InternalError({ type: "database" })),
					),
					Effect.catchTag("UnknownException", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
					),
					Effect.catchTag("StorageError", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
					),
				),

			VideosGetThumbnails: (videoIds) =>
				videos.getThumbnailURLs(videoIds).pipe(
					Effect.map(
						(results) =>
							results.map((result) =>
								Exit.mapError(result, (error) => {
									if (Schema.is(Policy.PolicyDeniedError)(error)) return error;
									if (Schema.is(Video.VerifyVideoPasswordError)(error))
										return error;
									return error as
										| Policy.PolicyDeniedError
										| Video.VerifyVideoPasswordError;
								}),
							) as readonly Exit.Exit<
								Option.Option<string>,
								Policy.PolicyDeniedError | Video.VerifyVideoPasswordError
							>[],
					),
					provideOptionalAuth,
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new InternalError({ type: "database" })),
					),
					Effect.catchTag("UnknownException", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
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
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new InternalError({ type: "database" })),
					),
					Effect.catchTag("UnknownException", () =>
						Effect.fail(new InternalError({ type: "unknown" })),
					),
				),
		};
	}),
);
