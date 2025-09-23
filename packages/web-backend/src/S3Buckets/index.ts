import * as S3 from "@aws-sdk/client-s3";
import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";
import { decrypt } from "@cap/database/crypto";
import { S3_BUCKET_URL } from "@cap/utils";
import type { S3Bucket } from "@cap/web-domain";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { Config, Context, Effect, Layer, Option } from "effect";

import { S3BucketAccess } from "./S3BucketAccess";
import { S3BucketClientProvider } from "./S3BucketClientProvider";
import { S3BucketsRepo } from "./S3BucketsRepo";

export class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
	effect: Effect.gen(function* () {
		const repo = yield* S3BucketsRepo;

		const defaultConfigs = {
			publicEndpoint: yield* Config.string("S3_PUBLIC_ENDPOINT").pipe(
				Config.orElse(() => Config.string("CAP_AWS_ENDPOINT")),
				Config.option,
			),
			internalEndpoint: yield* Config.string("S3_INTERNAL_ENDPOINT").pipe(
				Config.orElse(() => Config.string("CAP_AWS_ENDPOINT")),
				Config.option,
			),
			region: yield* Config.string("CAP_AWS_REGION"),
			credentials: yield* Config.string("CAP_AWS_ACCESS_KEY").pipe(
				Effect.zip(Config.string("CAP_AWS_SECRET_KEY")),
				Effect.map(([accessKeyId, secretAccessKey]) => ({
					accessKeyId,
					secretAccessKey,
				})),
				Effect.catchAll(() =>
					Config.string("VERCEL_AWS_ROLE_ARN").pipe(
						Effect.map((arn) => awsCredentialsProvider({ roleArn: arn })),
					),
				),
			),
			forcePathStyle:
				Option.getOrNull(
					yield* Config.boolean("S3_PATH_STYLE").pipe(Config.option),
				) ?? true,
			bucket: yield* Config.string("CAP_AWS_BUCKET"),
		};

		const createDefaultClient = (internal: boolean) =>
			new S3.S3Client({
				endpoint: internal
					? Option.getOrUndefined(defaultConfigs.internalEndpoint)
					: Option.getOrUndefined(defaultConfigs.publicEndpoint),
				region: defaultConfigs.region,
				credentials: defaultConfigs.credentials,
				forcePathStyle: defaultConfigs.forcePathStyle,
			});

		const createBucketClient = async (bucket: S3Bucket.S3Bucket) => {
			const endpoint = await (() => {
				const v = bucket.endpoint.pipe(Option.getOrUndefined);
				if (!v) return;
				return decrypt(v);
			})();

			const config = {
				endpoint,
				region: await decrypt(bucket.region),
				credentials: {
					accessKeyId: await decrypt(bucket.accessKeyId),
					secretAccessKey: await decrypt(bucket.secretAccessKey),
				},
				forcePathStyle:
					Option.fromNullable(endpoint).pipe(
						Option.map((e) => e.endsWith("s3.amazonaws.com")),
						Option.getOrNull,
					) ?? true,
				useArnRegion: false,
			};
			console.log({ config });
			return new S3.S3Client(config);
		};

		const defaultBucketAccess = S3BucketAccess.Default;

		const cloudfrontEnvs = yield* Config.all({
			distributionId: Config.string("CAP_CLOUDFRONT_DISTRIBUTION_ID"),
			keypairId: Config.string("CLOUDFRONT_KEYPAIR_ID"),
			privateKey: Config.string("CLOUDFRONT_KEYPAIR_PRIVATE_KEY"),
		}).pipe(
			Effect.match({
				onSuccess: (v) => v,
				onFailure: () => null,
			}),
			Effect.map(Option.fromNullable),
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
								}),
							);
						},
					});
				}),
			),
		);

		return {
			getProviderLayer: Effect.fn("S3Buckets.getProviderLayer")(function* (
				bucketId: Option.Option<S3Bucket.S3BucketId>,
			) {
				const customBucket = yield* bucketId.pipe(
					Option.map(repo.getById),
					Effect.transposeOption,
					Effect.map(Option.flatten),
				);

				let layer;

				if (Option.isNone(customBucket)) {
					const provider = Layer.succeed(S3BucketClientProvider, {
						getInternal: Effect.succeed(createDefaultClient(true)),
						getPublic: Effect.succeed(createDefaultClient(false)),
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
								getInternal: Effect.promise(() =>
									createBucketClient(customBucket.value),
								),
								getPublic: Effect.promise(() =>
									createBucketClient(customBucket.value),
								),
								bucket: yield* Effect.promise(() =>
									decrypt(customBucket.value.name),
								),
							}),
						),
					);
				}

				return [layer, customBucket] as const;
			}),
		};
	}),
	dependencies: [S3BucketsRepo.Default],
}) {}
