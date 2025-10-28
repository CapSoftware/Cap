import * as S3 from "@aws-sdk/client-s3";
import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";
import { fromContainerMetadata, fromSSO } from "@aws-sdk/credential-providers";
import { decrypt } from "@cap/database/crypto";
import type { S3Bucket, User } from "@cap/web-domain";
import { Config, Effect, Layer, Option } from "effect";

import { AwsCredentials } from "../Aws.ts";
import { Database } from "../Database.ts";
import { createS3BucketAccess } from "./S3BucketAccess.ts";
import { S3BucketClientProvider } from "./S3BucketClientProvider.ts";
import { S3BucketsRepo } from "./S3BucketsRepo.ts";

export class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
	effect: Effect.gen(function* () {
		const repo = yield* S3BucketsRepo;
		const { credentials } = yield* AwsCredentials;

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
			credentials,
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
				requestStreamBufferSize: 16 * 1024,
			});

		const endpointIsPathStyle = (endpoint: string, bucket: string) => {
			try {
				const { hostname } = new URL(endpoint);
				return !hostname.startsWith(`${bucket}.s3`);
			} catch {
				// If endpoint can't be parsed as a URL, fall back to false for safety
				return true;
			}
		};

		const createBucketClient = async (
			bucket: S3Bucket.S3Bucket,
			name: string,
		) => {
			const endpoint = await (() => {
				const v = bucket.endpoint.pipe(Option.getOrUndefined);
				if (!v) return;
				return decrypt(v);
			})();

			return new S3.S3Client({
				endpoint,
				region: await decrypt(bucket.region),
				credentials: {
					accessKeyId: await decrypt(bucket.accessKeyId),
					secretAccessKey: await decrypt(bucket.secretAccessKey),
				},
				forcePathStyle:
					Option.fromNullable(endpoint).pipe(
						Option.map((e) => endpointIsPathStyle(e, name)),
						Option.getOrNull,
					) ?? true,
				useArnRegion: false,
			});
		};

		const cloudfrontEnvs = yield* Config.all({
			distributionId: Config.string("CAP_CLOUDFRONT_DISTRIBUTION_ID"),
			keypairId: Config.string("CLOUDFRONT_KEYPAIR_ID"),
			privateKey: Config.string("CLOUDFRONT_KEYPAIR_PRIVATE_KEY"),
			bucketUrl: Config.string("CAP_AWS_BUCKET_URL"),
		}).pipe(
			Effect.match({
				onSuccess: (v) => v,
				onFailure: () => null,
			}),
			Effect.map(Option.fromNullable),
		);

		const cloudfrontBucketAccess = cloudfrontEnvs.pipe(
			Option.map((cloudfrontEnvs) =>
				Effect.flatMap(createS3BucketAccess, (s3) =>
					Effect.succeed<typeof s3>({
						...s3,
						getSignedObjectUrl: (key) => {
							const url = `${cloudfrontEnvs.bucketUrl}/${key}`;
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
					}),
				),
			),
		);

		const getBucketAccess = Effect.fn("S3Buckets.getProviderLayer")(function* (
			customBucket: Option.Option<S3Bucket.S3Bucket>,
		) {
			const bucketAccess = yield* Option.match(customBucket, {
				onNone: () => {
					const provider = Layer.succeed(S3BucketClientProvider, {
						getInternal: Effect.succeed(createDefaultClient(true)),
						getPublic: Effect.succeed(createDefaultClient(false)),
						bucket: defaultConfigs.bucket,
						isPathStyle: defaultConfigs.forcePathStyle,
					});

					return Option.match(cloudfrontBucketAccess, {
						onSome: (access) => access,
						onNone: () => createS3BucketAccess,
					}).pipe(Effect.provide(provider));
				},
				onSome: (customBucket) =>
					Effect.gen(function* () {
						const bucket = yield* Effect.promise(() =>
							decrypt(customBucket.name),
						);

						const client = yield* Effect.promise(() =>
							createBucketClient(customBucket, bucket),
						);
						const provider = Layer.succeed(S3BucketClientProvider, {
							getInternal: Effect.succeed(client),
							getPublic: Effect.succeed(client),
							bucket,
							isPathStyle: client.config.forcePathStyle ?? true,
						});

						return yield* createS3BucketAccess.pipe(Effect.provide(provider));
					}),
			});

			return [bucketAccess, customBucket] as const;
		});

		return {
			getBucketAccess: Effect.fn("S3Buckets.getBucketAccess")(function* (
				bucketId?: Option.Option<S3Bucket.S3BucketId>,
			) {
				const customBucket = yield* (bucketId ?? Option.none()).pipe(
					Option.map(repo.getById),
					Effect.transposeOption,
					Effect.map(Option.flatten),
				);

				return yield* getBucketAccess(customBucket);
			}),

			getBucketAccessForUser: Effect.fn("S3Buckets.getProviderForUser")(
				function* (userId: User.UserId) {
					return yield* repo
						.getForUser(userId)
						.pipe(
							Effect.option,
							Effect.map(Option.flatten),
							Effect.flatMap(getBucketAccess),
						);
				},
			),
		};
	}),
	dependencies: [
		S3BucketsRepo.Default,
		Database.Default,
		AwsCredentials.Default,
	],
}) {
	static getBucketAccess = (bucketId: Option.Option<S3Bucket.S3BucketId>) =>
		Effect.flatMap(S3Buckets, (b) =>
			b.getBucketAccess(Option.fromNullable(bucketId).pipe(Option.flatten)),
		);
	static getBucketAccessForUser = (userId: User.UserId) =>
		Effect.flatMap(S3Buckets, (b) => b.getBucketAccessForUser(userId));
}
