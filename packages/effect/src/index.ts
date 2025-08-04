import { Config, Context, Effect, Option } from "effect";
import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import {
  HttpApiBuilder,
  HttpApiError,
  HttpServerResponse,
} from "@effect/platform";
import { S3Client } from "@aws-sdk/client-s3";

import * as Policy from "./Policy";
import {
  Api,
  Database,
  S3Bucket,
  Video,
  VideoNeedsPassword,
  VideoNotFound,
  VideoPasswordAttachment,
} from "./domain";
import { createS3Layer, S3Provider } from "./S3Provider";

/**
 * Services
 *
 * Actual implementations that provide and consume domain items
 */

export class VideosRepo extends Effect.Service<VideosRepo>()("VideosRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database;

    return {
      getById: Effect.fn(function* (id: string) {
        const [video] = yield* db.execute((db) =>
          db.select().from(Db.videos).where(Dz.eq(Db.videos.id, id))
        );

        return Option.fromNullable(video).pipe(
          Option.map((v) =>
            Video.decodeSync({
              id: v.id,
              password: v.password,
              ownerId: v.ownerId,
              bucketId: v.bucket,
              source: v.source,
            })
          )
        );
      }),
    };
  }),
}) {}

export class S3BucketsRepo extends Effect.Service<S3BucketsRepo>()(
  "S3BucketsRepo",
  {
    effect: Effect.gen(function* () {
      const db = yield* Database;

      const getForVideo = Effect.fnUntraced(function* (videoId: string) {
        const [res] = yield* db.execute((db) =>
          db
            .select({ bucket: Db.s3Buckets })
            .from(Db.s3Buckets)
            .leftJoin(Db.videos, Dz.eq(Db.videos.bucket, Db.s3Buckets.id))
            .where(Dz.and(Dz.eq(Db.videos.id, videoId)))
        );

        return Option.fromNullable(res).pipe(
          Option.map((v) =>
            S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName })
          )
        );
      });

      return { getForVideo };
    }),
  }
) {}

export class VideosPolicy extends Effect.Service<VideosPolicy>()(
  "VideosPolicy",
  {
    effect: Effect.gen(function* () {
      const videosRepo = yield* VideosRepo;

      const canView = (id: string) =>
        Policy.publicPolicy(
          Effect.fn(function* (user) {
            const video = yield* videosRepo.getById(id).pipe(
              Effect.flatten,
              Effect.catchTag(
                "NoSuchElementException",
                () => new VideoNotFound({ id })
              )
            );

            if (
              user.pipe(
                Option.filter((user) => user.id === video.ownerId),
                Option.isSome
              )
            )
              return true;

            if (Option.isNone(video.password)) return true;
            const videoPassword = video.password.value;

            const passwordAttachment = Context.getOption(
              yield* Effect.context<never>(),
              VideoPasswordAttachment
            );

            return yield* Option.match(passwordAttachment, {
              onSome(attachment) {
                const passwordsEqual = attachment.password === videoPassword;

                if (passwordsEqual) return Effect.succeed(true);

                return new VideoNeedsPassword({ id, cause: "wrong-password" });
              },
              onNone: () =>
                new VideoNeedsPassword({ id, cause: "not-provided" }),
            });
          })
        );

      return { canView };
    }),
    dependencies: [VideosRepo.Default],
  }
) {}

export class S3ProviderFactory extends Effect.Service<S3ProviderFactory>()(
  "S3ProviderFactory",
  {
    effect: Effect.gen(function* () {
      const defaultConfigs = {
        publicEndpoint: yield* Config.string("S3_PUBLIC_ENDPOINT").pipe(
          Config.orElse(() => Config.string("CAP_AWS_ENDPOINT")),
          Config.option,
          Effect.flatten,
          Effect.catchTag("NoSuchElementException", () =>
            Effect.dieMessage(
              "Neither S3_PUBLIC_ENDPOINT nor CAP_AWS_ENDPOINT provided"
            )
          )
        ),
        internalEndpoint: yield* Config.string("S3_INTERNAL_ENDPOINT").pipe(
          Config.orElse(() => Config.string("CAP_AWS_ENDPOINT")),
          Config.option,
          Effect.flatten,
          Effect.catchTag("NoSuchElementException", () =>
            Effect.dieMessage(
              "Neither S3_INTERNAL_ENDPOINT nor CAP_AWS_ENDPOINT provided"
            )
          )
        ),
        region: yield* Config.string("CAP_AWS_REGION"),
        accessKey: yield* Config.string("CAP_AWS_ACCESS_KEY"),
        secretKey: yield* Config.string("CAP_AWS_SECRET_KEY"),
        forcePathStyle:
          Option.getOrNull(
            yield* Config.boolean("S3_PATH_STYLE").pipe(Config.option)
          ) ?? true,
        bucket: yield* Config.string("CAP_AWS_BUCKET"),
      };

      const createDefaultClient = (internal: boolean) =>
        Effect.succeed(
          new S3Client({
            endpoint: internal
              ? defaultConfigs.internalEndpoint
              : defaultConfigs.publicEndpoint,
            region: defaultConfigs.region,
            credentials: {
              accessKeyId: defaultConfigs.accessKey,
              secretAccessKey: defaultConfigs.secretKey,
            },
            forcePathStyle: defaultConfigs.forcePathStyle,
          })
        );

      const createBucketClient = (bucket: S3Bucket) =>
        Effect.succeed(
          new S3Client({
            endpoint: bucket.endpoint.pipe(Option.getOrUndefined),
            region: bucket.region,
            credentials: {
              accessKeyId: bucket.accessKeyId,
              secretAccessKey: bucket.secretAccessKey,
            },
            forcePathStyle:
              bucket.endpoint.pipe(
                Option.map((e) => e.endsWith("s3.amazonaws.com")),
                Option.getOrNull
              ) ?? true,
            useArnRegion: false,
          })
        );

      return {
        default: createS3Layer(createDefaultClient, defaultConfigs.bucket),
        fromBucket: (bucket: S3Bucket) => {
          const client = createBucketClient(bucket);
          return createS3Layer(() => client, bucket.name);
        },
      };
    }),
  }
) {}

export const ApiLive = HttpApiBuilder.group(
  Api,
  "root",
  Effect.fnUntraced(function* (handlers) {
    const videosRepo = yield* VideosRepo;
    const videosPolicy = yield* VideosPolicy;
    const s3BucketsRepo = yield* S3BucketsRepo;
    const s3ProviderFactory = yield* S3ProviderFactory;

    return handlers.handle("playlist", ({ urlParams }) =>
      Effect.gen(function* () {
        const video = yield* videosRepo
          .getById(urlParams.videoId)
          .pipe(
            Policy.withPolicy(videosPolicy.canView(urlParams.videoId)),
            Effect.flatten
          );

        const customBucket = yield* s3BucketsRepo.getForVideo(video.id);

        const s3 = Option.match(customBucket, {
          onNone: () => s3ProviderFactory.default,
          onSome: (bucket) => s3ProviderFactory.fromBucket(bucket),
        });

        return yield* Effect.gen(function* () {
          const s3 = yield* S3Provider;

          if (Option.isNone(customBucket)) {
            if (video.source.type === "desktopMP4")
              return HttpServerResponse.redirect(
                yield* Effect.promise(() =>
                  s3.getSignedObjectUrl(
                    `${video.ownerId}/${video.id}/result.mp4`
                  )
                )
              );

            if (video.source.type === "MediaConvert")
              return HttpServerResponse.redirect(
                yield* Effect.promise(() =>
                  s3.getSignedObjectUrl(
                    `${video.ownerId}/${video.id}/output/video_recording_000.m3u8`
                  )
                )
              );

            return HttpServerResponse.redirect(
              yield* Effect.promise(() =>
                s3.getSignedObjectUrl(
                  `${video.ownerId}/${video.id}/combined-source/stream.m3u8`
                )
              )
            );
          }

          // TODO: handle more
        }).pipe(Effect.provide(s3));
      }).pipe(
        Effect.catchTags({
          VideoNotFound: () => new HttpApiError.NotFound(),
          NoSuchElementException: () => new HttpApiError.NotFound(),
          VideoNeedsPassword: () => new HttpApiError.Forbidden(),
          PolicyDenied: () => new HttpApiError.Unauthorized(),
          DatabaseError: (e) =>
            Effect.logError(e).pipe(
              Effect.andThen(() => new HttpApiError.InternalServerError())
            ),
        })
      )
    );
  })
);
