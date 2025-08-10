import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { Videos } from "@cap/web-backend";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("Api").add(
  HttpApiGroup.make("root").add(
    HttpApiEndpoint.del("deleteVideo")`/api/video/delete`
      .setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
      .middleware(HttpAuthMiddleware)
      .addError(HttpApiError.Forbidden)
      .addError(HttpApiError.NotFound)
  )
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(
    HttpApiBuilder.group(Api, "root", (handlers) =>
      Effect.gen(function* () {
        const videos = yield* Videos;

        return handlers.handle("deleteVideo", ({ urlParams }) =>
          Effect.gen(function* () {
            yield* videos.delete(urlParams.videoId);

            return HttpServerResponse.unsafeJson(true);
          }).pipe(
            Effect.catchTags({
              VideoNotFoundError: () => new HttpApiError.NotFound(),
              PolicyDenied: () => new HttpApiError.Unauthorized(),
              DatabaseError: (e) =>
                Effect.logError(e).pipe(
                  Effect.andThen(() => new HttpApiError.InternalServerError())
                ),
              S3Error: (e) =>
                Effect.logError(e).pipe(
                  Effect.andThen(() => new HttpApiError.InternalServerError())
                ),
            })
          )
        );
      })
    )
  )
);

const { handler } = apiToHandler(ApiLive);

export const DELETE = handler;
