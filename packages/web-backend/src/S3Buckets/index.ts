import * as S3 from "@aws-sdk/client-s3";
import * as CloudFrontPresigner from "@aws-sdk/cloudfront-signer";
import { decrypt } from "@cap/database/crypto";
import type { Organisation, S3Bucket, User } from "@cap/web-domain";
import type { RequestPresigningArguments } from "@smithy/types";
import { Config, Context, Effect, Layer, Option } from "effect";

import { AwsCredentials } from "../Aws.ts";
import { Database } from "../Database.ts";
import { createS3BucketAccess } from "./S3BucketAccess.ts";
import { S3BucketClientProvider } from "./S3BucketClientProvider.ts";
import { S3BucketsRepo } from "./S3BucketsRepo.ts";
import { s3ConnectionPool } from "./S3ConnectionPool.ts";

const makeS3Buckets = Effect.gen(function* () {
	const repo = yield* S3BucketsRepo;
	const { credentials } = yield* AwsCredentials;
	const requestHandler = yield* s3ConnectionPool;

	const defaultConfigs = {
		publicEndpoint: yield* Config.String("S3_PUBLIC_ENDPOINT").pipe(
			Config.orElse(() => Config.String("CAP_AWS_ENDPOINT")),
			Config.option,
		),
		internalEndpoint: yield* Config.String("S3_INTERNAL_ENDPOINT").pipe(
			Config.orElse(() => Config.String("CAP_AWS_ENDPOINT")),
			Config.option,
		),
		region: yield* Config.String("CAP_AWS_REGION"),
		credentials,
		forcePathStyle:
			Option.getOrNull(
				yield* Config.Boolean("S3_PATH_STYLE").pipe(Config.option),
			) ?? true,
		bucket: yield* Config.String("CAP_AWS_BUCKET"),
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
			requestHandler,
		});
	const defaultInternalClient = createDefaultClient(true);
	const defaultPublicClient = createDefaultClient(false);

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
				Option.fromNullishOr(endpoint).pipe(
					Option.map((e) => endpointIsPathStyle(e, name)),
					Option.getOrNull,
				) ?? true,
			useArnRegion: false,
			requestHandler,
		});
	};

	const cloudfrontEnvs = yield* Config.all({
		distributionId: Config.String("CAP_CLOUDFRONT_DISTRIBUTION_ID"),
		keypairId: Config.String("CLOUDFRONT_KEYPAIR_ID"),
		privateKey: Config.String("CLOUDFRONT_KEYPAIR_PRIVATE_KEY"),
		bucketUrl: Config.String("CAP_AWS_BUCKET_URL"),
	}).pipe(
		Effect.match({
			onSuccess: (v) => v,
			onFailure: () => null,
		}),
		Effect.map(Option.fromNullishOr),
	);

	const cloudfrontBucketAccess = cloudfrontEnvs.pipe(
		Option.map((cloudfrontEnvs) =>
			Effect.flatMap(createS3BucketAccess, (s3) => {
				const getCloudFrontSignedUrl = (
					key: string,
					signingArgs?: RequestPresigningArguments,
				) => {
					const url = `${cloudfrontEnvs.bucketUrl}/${key}`;
					const expiresIn = signingArgs?.expiresIn ?? 3600;
					const expires = Math.floor((Date.now() + expiresIn * 1000) / 1000);

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
				};

				return Effect.succeed<typeof s3>({
					...s3,
					getSignedObjectUrl: getCloudFrontSignedUrl,
				});
			}),
		),
	);

	const getBucketAccess = Effect.fn("S3Buckets.getProviderLayer")(function* (
		customBucket: Option.Option<S3Bucket.S3Bucket>,
	) {
		const bucketAccess = yield* Option.match(customBucket, {
			onNone: () => {
				const provider = Layer.succeed(S3BucketClientProvider, {
					getInternal: Effect.succeed(defaultInternalClient),
					getPublic: Effect.succeed(defaultPublicClient),
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
		getBucketAccessForOrganization: Effect.fn(
			"S3Buckets.getBucketAccessForOrganization",
		)(function* (organizationId: Organisation.OrganisationId) {
			const customBucket = yield* repo.getForOrganization(organizationId);

			return yield* Option.match(customBucket, {
				onNone: () => Effect.succeed(Option.none()),
				onSome: (bucket) =>
					getBucketAccess(Option.some(bucket)).pipe(Effect.map(Option.some)),
			});
		}),
	};
});

export class S3Buckets extends Context.Service<
	S3Buckets,
	Effect.Success<typeof makeS3Buckets>
>()("S3Buckets") {
	static readonly Default = Layer.effect(this, makeS3Buckets).pipe(
		Layer.provide(
			Layer.mergeAll(
				S3BucketsRepo.Default,
				Database.Default,
				AwsCredentials.Default,
			),
		),
	);
	static getBucketAccess = (bucketId: Option.Option<S3Bucket.S3BucketId>) =>
		Effect.flatMap(S3Buckets, (b) =>
			b.getBucketAccess(Option.fromNullishOr(bucketId).pipe(Option.flatten)),
		);
	static getBucketAccessForUser = (userId: User.UserId) =>
		Effect.flatMap(S3Buckets, (b) => b.getBucketAccessForUser(userId));
	static getBucketAccessForOrganization = (
		organizationId: Organisation.OrganisationId,
	) =>
		Effect.flatMap(S3Buckets, (b) =>
			b.getBucketAccessForOrganization(organizationId),
		);
}
