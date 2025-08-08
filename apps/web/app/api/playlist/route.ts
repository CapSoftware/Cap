import { db } from "@cap/database";
import {
  generateM3U8Playlist,
  generateMasterPlaylist,
} from "@/utils/video/ffmpeg/helpers";
import { CACHE_CONTROL_HEADERS } from "@/utils/helpers";
import { serverEnv } from "@cap/env";
import { Effect, Layer, Option, Schema } from "effect";
import { allowedOrigins } from "../utils";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Videos } from "@/services";
import { Database, DatabaseError, Video } from "@cap/web-domain";
import { S3Buckets } from "services/S3Buckets";
import { S3BucketAccess } from "services/S3Buckets/S3BucketAccess";
import { NodeSdk } from "@effect/opentelemetry";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  AuthMiddlewareLive,
  provideOptionalAuth,
} from "services/Authentication";

export const revalidate = "force-dynamic";

const NodeSdkLive = NodeSdk.layer(() => ({
  resource: { serviceName: "cap-web" },
  spanProcessor: [new BatchSpanProcessor(new OTLPTraceExporter())],
}));

const DatabaseLive = Layer.sync(Database, () => ({
  execute: (cb) =>
    Effect.tryPromise({
      try: () => cb(db()),
      catch: (error) => new DatabaseError({ message: String(error) }),
    }),
}));

const Dependencies = Layer.mergeAll(S3Buckets.Default, Videos.Default).pipe(
  Layer.provideMerge(DatabaseLive),
  Layer.provide(NodeSdkLive)
);

const run = Effect.gen(function* () {
  const s3Buckets = yield* S3Buckets;

  const body = yield* HttpServerRequest.schemaSearchParams(
    Schema.Struct({
      videoId: Video.VideoId,
      videoType: Schema.Literal("video", "audio", "master", "mp4"),
      thumbnail: Schema.OptionFromUndefinedOr(Schema.String),
      fileType: Schema.OptionFromUndefinedOr(Schema.String),
    })
  );

  const video = yield* Videos.getById(body.videoId).pipe(
    Effect.andThen(
      Effect.catchTag(
        "NoSuchElementException",
        () => new HttpApiError.NotFound()
      )
    )
  );

  const [S3ProviderLayer, customBucket] =
    yield* s3Buckets.getProviderLayerForVideo(video.id);

  return yield* Effect.gen(function* () {
    const s3 = yield* S3BucketAccess;

    if (Option.isNone(customBucket)) {
      let redirect = `${video.ownerId}/${video.id}/combined-source/stream.m3u8`;

      if (video.source.type === "desktopMP4")
        redirect = `${video.ownerId}/${video.id}/result.mp4`;
      else if (video.source.type === "MediaConvert")
        redirect = `${video.ownerId}/${video.id}/output/video_recording_000.m3u8`;

      // yield* Effect.log(`Redirecting to: ${redirect}`);

      return HttpServerResponse.redirect(
        yield* s3.getSignedObjectUrl(redirect)
      );
    }

    if (
      Option.isSome(body.fileType) &&
      body.fileType.value === "transcription"
    ) {
      return yield* s3
        .getObject(`${video.ownerId}/${video.id}/transcription.vtt`)
        .pipe(
          Effect.andThen(
            Option.match({
              onNone: () => new HttpApiError.NotFound(),
              onSome: (c) =>
                HttpServerResponse.text(c).pipe(
                  HttpServerResponse.setHeaders({
                    ...CACHE_CONTROL_HEADERS,
                    "Content-Type": "text/vtt",
                  })
                ),
            })
          ),
          Effect.withSpan("fetchTranscription")
        );
    }

    const videoPrefix = `${video.ownerId}/${video.id}/video/`;
    const audioPrefix = `${video.ownerId}/${video.id}/audio/`;

    return yield* Effect.gen(function* () {
      if (video.source.type === "local") {
        const playlistText =
          (yield* s3.getObject(
            `${video.ownerId}/${video.id}/combined-source/stream.m3u8`
          )).pipe(Option.getOrNull) ?? "";

        const lines = playlistText.split("\n");

        for (const [index, line] of lines.entries()) {
          if (line.endsWith(".ts")) {
            const url = yield* s3.getObject(
              `${video.ownerId}/${video.id}/combined-source/${line}`
            );
            if (Option.isNone(url)) continue;
            lines[index] = url.value;
          }
        }

        const playlist = lines.join("\n");

        return HttpServerResponse.text(playlist, {
          headers: CACHE_CONTROL_HEADERS,
        });
      } else if (video.source.type === "desktopMP4") {
        return yield* s3
          .getSignedObjectUrl(`${video.ownerId}/${video.id}/result.mp4`)
          .pipe(Effect.map(HttpServerResponse.redirect));
      }

      let prefix;
      switch (body.videoType) {
        case "video":
          prefix = videoPrefix;
          break;
        case "audio":
          prefix = audioPrefix;
          break;
        case "master":
          prefix = null;
          break;
      }

      if (prefix === null) {
        const [videoSegment, audioSegment] = yield* Effect.all([
          s3.listObjects({ prefix: videoPrefix, maxKeys: 1 }),
          s3.listObjects({ prefix: audioPrefix, maxKeys: 1 }),
        ]);

        let audioMetadata;
        const videoMetadata = yield* s3.headObject(
          videoSegment.Contents?.[0]?.Key ?? ""
        );
        if (audioSegment?.KeyCount && audioSegment?.KeyCount > 0) {
          audioMetadata = yield* s3.headObject(
            audioSegment.Contents?.[0]?.Key ?? ""
          );
        }

        const generatedPlaylist = generateMasterPlaylist(
          videoMetadata?.Metadata?.resolution ?? "",
          videoMetadata?.Metadata?.bandwidth ?? "",
          `${serverEnv().WEB_URL}/api/playlist?userId=${
            video.ownerId
          }&videoId=${video.id}&videoType=video`,
          audioMetadata
            ? `${serverEnv().WEB_URL}/api/playlist?userId=${
                video.ownerId
              }&videoId=${video.id}&videoType=audio`
            : null
        );

        return HttpServerResponse.text(generatedPlaylist, {
          headers: CACHE_CONTROL_HEADERS,
        });
      }

      const objects = yield* s3.listObjects({
        prefix,
        maxKeys: body.thumbnail ? 1 : undefined,
      });

      const chunksUrls = yield* Effect.all(
        (objects.Contents || []).map((object) =>
          Effect.gen(function* () {
            const url = yield* s3.getSignedObjectUrl(object.Key ?? "");
            const metadata = yield* s3.headObject(object.Key ?? "");

            return {
              url: url,
              duration: metadata?.Metadata?.duration ?? "",
              bandwidth: metadata?.Metadata?.bandwidth ?? "",
              resolution: metadata?.Metadata?.resolution ?? "",
              videoCodec: metadata?.Metadata?.videocodec ?? "",
              audioCodec: metadata?.Metadata?.audiocodec ?? "",
            };
          })
        )
      );

      const generatedPlaylist = generateM3U8Playlist(chunksUrls);

      return HttpServerResponse.text(generatedPlaylist, {
        headers: CACHE_CONTROL_HEADERS,
      });
    }).pipe(Effect.withSpan("generateUrls"));
  }).pipe(Effect.provide(S3ProviderLayer));
}).pipe(
  provideOptionalAuth,
  Effect.catchTags({
    VerifyVideoPasswordError: (e) => new HttpApiError.Forbidden(),
    ParseError: () => new HttpApiError.BadRequest(),
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
);

const Api = HttpApi.make("").add(
  HttpApiGroup.make("").add(
    HttpApiEndpoint.get("")`/api/playlist`
      .addError(HttpApiError.Forbidden)
      .addError(HttpApiError.BadRequest)
      .addError(HttpApiError.Unauthorized)
      .addError(HttpApiError.InternalServerError)
      .addError(HttpApiError.NotFound)
  )
);

const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(
    HttpApiBuilder.group(Api, "", (handlers) => handlers.handle("", () => run))
  )
);

const cors = HttpApiBuilder.middlewareCors({
  allowedOrigins,
  credentials: true,
  allowedMethods: ["GET", "HEAD", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
});

const { handler } = Layer.empty.pipe(
  Layer.merge(ApiLive),
  Layer.merge(AuthMiddlewareLive),
  Layer.provideMerge(Dependencies),
  Layer.merge(HttpServer.layerContext),
  Layer.provide(cors),
  HttpApiBuilder.toWebHandler
);

export const GET = handler;
export const HEAD = handler;
