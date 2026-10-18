import { Videos } from "@cap/web-backend";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import { Effect, Layer, Schema } from "effect";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "effect/http-api";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("Api").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.delete("deleteVideo", "/api/video/delete", {
			query: Schema.Struct({ videoId: Video.VideoId }),
			error: [
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
				HttpApiError.Unauthorized,
				HttpApiError.InternalServerError,
			],
		}).middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.layer(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			Effect.gen(function* () {
				const videos = yield* Videos;

				return handlers.handle("deleteVideo", ({ query: urlParams }) =>
					videos.delete(urlParams.videoId).pipe(
						Effect.catchTags({
							VideoNotFoundError: () =>
								Effect.fail(new HttpApiError.NotFound()),
							PolicyDenied: () => Effect.fail(new HttpApiError.Unauthorized()),
							DatabaseError: (e) =>
								Effect.logError(e).pipe(
									Effect.andThen(() =>
										Effect.fail(new HttpApiError.InternalServerError()),
									),
								),
							StorageError: (e) =>
								Effect.logError(e).pipe(
									Effect.andThen(() =>
										Effect.fail(new HttpApiError.InternalServerError()),
									),
								),
						}),
					),
				);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const DELETE = handler;
