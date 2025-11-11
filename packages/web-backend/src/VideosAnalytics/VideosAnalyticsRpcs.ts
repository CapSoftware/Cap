import { InternalError, VideoAnalytics } from "@cap/web-domain";
import { Effect, Exit, Schema, Unify } from "effect";

import { provideOptionalAuth } from "../Auth.ts";
import { VideosAnalytics } from "./index.ts";

export const VideosAnalyticsRpcsLive =
	VideoAnalytics.VideoAnalyticsRpcs.toLayer(
		Effect.gen(function* () {
			const videosAnalytics = yield* VideosAnalytics;

			return {
				VideosGetViewCount: (videoIds) =>
					Effect.all(
						videoIds.map((id) =>
							videosAnalytics.getViewCount(id).pipe(
								Effect.catchTags({
									DatabaseError: () => new InternalError({ type: "database" }),
									RequestError: () =>
										new InternalError({ type: "httpRequest" }),
									ResponseError: () =>
										new InternalError({ type: "httpResponse" }),
									UnknownException: () =>
										new InternalError({ type: "unknown" }),
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

				VideosGetAnalytics: (videoId) =>
					videosAnalytics.getAnalytics(videoId).pipe(
						provideOptionalAuth,
						Effect.catchTags({
							DatabaseError: () => new InternalError({ type: "database" }),
							UnknownException: () => new InternalError({ type: "unknown" }),
						}),
					),

				VideosCaptureEvent: (event) =>
					videosAnalytics.captureEvent(event).pipe(
						provideOptionalAuth,
						Effect.catchTags({
							DatabaseError: () => new InternalError({ type: "database" }),
							HttpBodyError: () => new InternalError({ type: "httpRequest" }),
							RequestError: () => new InternalError({ type: "httpRequest" }),
							ResponseError: () => new InternalError({ type: "httpResponse" }),
							UnknownException: () => new InternalError({ type: "unknown" }),
						}),
					),
			};
		}),
	);
