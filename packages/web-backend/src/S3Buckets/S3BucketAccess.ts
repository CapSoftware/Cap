import * as S3 from "@aws-sdk/client-s3";
import {
	createPresignedPost,
	type PresignedPostOptions,
} from "@aws-sdk/s3-presigned-post";
import * as S3Presigner from "@aws-sdk/s3-request-presigner";
import type {
	RequestPresigningArguments,
	StreamingBlobPayloadInputTypes,
} from "@smithy/types";
import { type Cause, Data, Effect, Option } from "effect";
import { S3BucketClientProvider } from "./S3BucketClientProvider";

export class S3Error extends Data.TaggedError("S3Error")<{ message: string }> {}

const wrapS3Promise = <T>(
	callback: (
		provider: S3BucketClientProvider["Type"],
	) => Promise<T> | Effect.Effect<Promise<T>, Cause.UnknownException>,
): Effect.Effect<T, Cause.UnknownException | S3Error, S3BucketClientProvider> =>
	Effect.gen(function* () {
		const provider = yield* S3BucketClientProvider;

		const cbResult = callback(provider);

		if (cbResult instanceof Promise) {
			return yield* Effect.tryPromise({
				try: () => cbResult,
				catch: (e) => new S3Error({ message: String(e) }),
			});
		}

		return yield* cbResult.pipe(
			Effect.flatMap((cbResult) =>
				Effect.tryPromise({
					try: () => cbResult,
					catch: (e) => new S3Error({ message: String(e) }),
				}),
			),
		);
	});

// @effect-diagnostics-next-line leakingRequirements:off
export class S3BucketAccess extends Effect.Service<S3BucketAccess>()(
	"S3BucketAccess",
	{
		sync: () => ({
			bucketName: Effect.map(S3BucketClientProvider, (p) => p.bucket),
			getSignedObjectUrl: (key: string) =>
				wrapS3Promise((provider) =>
					provider.getPublic.pipe(
						Effect.map((client) =>
							S3Presigner.getSignedUrl(
								client,
								new S3.GetObjectCommand({ Bucket: provider.bucket, Key: key }),
								{ expiresIn: 3600 },
							),
						),
					),
				).pipe(Effect.withSpan("getSignedObjectUrl")),
			getObject: (key: string) =>
				wrapS3Promise((provider) =>
					provider.getInternal.pipe(
						Effect.map(async (client) => {
							const a = await client
								.send(
									new S3.GetObjectCommand({
										Bucket: provider.bucket,
										Key: key,
									}),
								)
								.then((resp) => resp.Body?.transformToString())
								.catch((e) => {
									if (e instanceof S3.NoSuchKey) {
										return null;
									} else {
										throw e;
									}
								});
							return Option.fromNullable(a);
						}),
					),
				),
			listObjects: (config: { prefix?: string; maxKeys?: number }) =>
				wrapS3Promise((provider) =>
					provider.getInternal.pipe(
						Effect.map((client) =>
							client.send(
								new S3.ListObjectsV2Command({
									Bucket: provider.bucket,
									Prefix: config?.prefix,
									MaxKeys: config?.maxKeys,
								}),
							),
						),
					),
				),
			headObject: (key: string) =>
				wrapS3Promise((provider) =>
					provider.getInternal.pipe(
						Effect.map((client) =>
							client.send(
								new S3.HeadObjectCommand({ Bucket: provider.bucket, Key: key }),
							),
						),
					),
				),
			putObject: (
				key: string,
				body: StreamingBlobPayloadInputTypes,
				fields?: { contentType?: string; contentLength?: number },
			) =>
				wrapS3Promise((provider) =>
					provider.getInternal.pipe(
						Effect.map((client) =>
							client.send(
								new S3.PutObjectCommand({
									Bucket: provider.bucket,
									Key: key,
									Body: body,
									ContentType: fields?.contentType,
									ContentLength: fields?.contentLength,
								}),
							),
						),
					),
				).pipe(
					Effect.withSpan("S3BucketAccess.putObject", { attributes: { key } }),
				),
			/** Copy an object within the same bucket */
			copyObject: (
				source: string,
				key: string,
				args?: Omit<S3.CopyObjectCommandInput, "Bucket" | "CopySource" | "Key">,
			) =>
				wrapS3Promise((provider) =>
					provider.getInternal.pipe(
						Effect.map((client) =>
							client.send(
								new S3.CopyObjectCommand({
									Bucket: provider.bucket,
									CopySource: source,
									Key: key,
									...args,
								}),
							),
						),
					),
				),
			deleteObject: (key: string) =>
				wrapS3Promise((provider) =>
					provider.getInternal.pipe(
						Effect.map((client) =>
							client.send(
								new S3.DeleteObjectCommand({
									Bucket: provider.bucket,
									Key: key,
								}),
							),
						),
					),
				),
			deleteObjects: (objects: S3.ObjectIdentifier[]) =>
				wrapS3Promise((provider) =>
					provider.getInternal.pipe(
						Effect.map((client) =>
							client.send(
								new S3.DeleteObjectsCommand({
									Bucket: provider.bucket,
									Delete: {
										Objects: objects,
									},
								}),
							),
						),
					),
				),
			getPresignedPutUrl: (
				key: string,
				args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
				signingArgs?: RequestPresigningArguments,
			) =>
				wrapS3Promise((provider) =>
					provider.getPublic.pipe(
						Effect.map((client) =>
							S3Presigner.getSignedUrl(
								client,
								new S3.PutObjectCommand({
									Bucket: provider.bucket,
									Key: key,
									...args,
								}),
								signingArgs,
							),
						),
					),
				),
			getPresignedPostUrl: (
				key: string,
				args: Omit<PresignedPostOptions, "Bucket" | "Key">,
			) =>
				wrapS3Promise((provider) =>
					provider.getPublic.pipe(
						Effect.map((client) =>
							createPresignedPost(client, {
								...args,
								Bucket: provider.bucket,
								Key: key,
							}),
						),
					),
				),
			multipart: {
				create: (
					key: string,
					args?: Omit<S3.CreateMultipartUploadCommandInput, "Bucket" | "Key">,
				) =>
					wrapS3Promise((provider) =>
						provider.getInternal.pipe(
							Effect.map((client) =>
								client.send(
									new S3.CreateMultipartUploadCommand({
										...args,
										Bucket: provider.bucket,
										Key: key,
									}),
								),
							),
						),
					),
				getPresignedUploadPartUrl: (
					key: string,
					uploadId: string,
					partNumber: number,
					args?: Omit<
						S3.UploadPartCommandInput,
						"Key" | "Bucket" | "PartNumber" | "UploadId"
					>,
				) =>
					wrapS3Promise((provider) =>
						provider.getPublic.pipe(
							Effect.map((client) =>
								S3Presigner.getSignedUrl(
									client,
									new S3.UploadPartCommand({
										...args,
										Bucket: provider.bucket,
										Key: key,
										UploadId: uploadId,
										PartNumber: partNumber,
									}),
								),
							),
						),
					),
				complete: (
					key: string,
					uploadId: string,
					args?: Omit<
						S3.CompleteMultipartUploadCommandInput,
						"Key" | "Bucket" | "UploadId"
					>,
				) =>
					wrapS3Promise((provider) =>
						provider.getInternal.pipe(
							Effect.map((client) =>
								client.send(
									new S3.CompleteMultipartUploadCommand({
										Bucket: provider.bucket,
										Key: key,
										UploadId: uploadId,
										...args,
									}),
								),
							),
						),
					),
			},
		}),
	},
) {}
