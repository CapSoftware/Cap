import { S3Bucket, Video } from "@cap/web-domain";
import { Config, Context, Effect, Layer, Option } from "effect";
import * as S3 from "@aws-sdk/client-s3";
import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";
import { S3_BUCKET_URL } from "@cap/utils";

import { S3BucketsRepo } from "./S3BucketsRepo";
import { S3BucketAccess, S3Error } from "./S3BucketAccess";
import { S3BucketClientProvider } from "./S3BucketClientProvider";

export class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
  effect: Effect.gen(function* () {
    const repo = yield* S3BucketsRepo;

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
      new S3.S3Client({
        endpoint: internal
          ? defaultConfigs.internalEndpoint
          : defaultConfigs.publicEndpoint,
        region: defaultConfigs.region,
        credentials: {
          accessKeyId: defaultConfigs.accessKey,
          secretAccessKey: defaultConfigs.secretKey,
        },
        forcePathStyle: defaultConfigs.forcePathStyle,
      });

    const createBucketClient = (bucket: S3Bucket.S3Bucket) =>
      new S3.S3Client({
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
      });

    const defaultBucketAccess = S3BucketAccess.Default;

    const cloudfrontEnvs = yield* Config.all({
      distributionId: Config.string("CAP_CLOUDFRONT_DISTRIBUTION_ID"),
      keypairId: Config.string("CLOUDFRONT_KEYPAIR_ID"),
      privateKey: Config.string("CLOUDFRONT_PRIVATE_KEY"),
    }).pipe(
      Effect.match({
        onSuccess: (v) => v,
        onFailure: () => null,
      }),
      Effect.map(Option.fromNullable)
    );

    const cloudfrontBucketAccess = cloudfrontEnvs.pipe(
      Option.map((cloudfrontEnvs) =>
        Layer.map(defaultBucketAccess, (context) => {
          const s3 = Context.get(context, S3BucketAccess);

          return Context.make(S3BucketAccess, {
            ...s3,
            getSignedObjectUrl: (key) => {
              const url = `${S3_BUCKET_URL}/${key}`;
              const expires = Math.floor((Date.now() + 3600 * 1000) / 1000);

              const policy = {
                Statement: [
                  {
                    Resource: url,
                    Condition: {
                      DateLessThan: {
                        "AWS:EpochTime": Math.floor(expires),
                      },
                    },
                  },
                ],
              };

              return Effect.succeed(
                CloudFrontPresigner.getSignedUrl({
                  url,
                  keyPairId: cloudfrontEnvs.keypairId,
                  privateKey: cloudfrontEnvs.privateKey,
                  policy: JSON.stringify(policy),
                })
              );
            },
          });
        })
      )
    );

    return {
      getProviderLayerForVideo: (videoId: Video.VideoId) =>
        Effect.gen(function* () {
          const customBucket = yield* repo.getForVideo(videoId);

          let layer;

          if (Option.isNone(customBucket)) {
            const provider = Layer.succeed(S3BucketClientProvider, {
              getInternal: () => createDefaultClient(true),
              getPublic: () => createDefaultClient(false),
              bucket: defaultConfigs.bucket,
            });

            layer = Option.match(cloudfrontBucketAccess, {
              onSome: (access) => access,
              onNone: () => defaultBucketAccess,
            }).pipe(Layer.merge(provider));
          } else {
            layer = defaultBucketAccess.pipe(
              Layer.merge(
                Layer.succeed(S3BucketClientProvider, {
                  getInternal: () => createBucketClient(customBucket.value),
                  getPublic: () => createBucketClient(customBucket.value),
                  bucket: customBucket.value.name,
                })
              )
            );
          }

          return [layer, customBucket] as const;
        }).pipe(Effect.withSpan("S3Buckets.getProviderLayerForVideo")),
    };
  }),
  dependencies: [S3BucketsRepo.Default],
}) {}
