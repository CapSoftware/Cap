import { Readable } from "node:stream";
import * as S3 from "@aws-sdk/client-s3";
import {
	createPresignedPost,
	type PresignedPostOptions,
} from "@aws-sdk/s3-presigned-post";
import * as S3Presigner from "@aws-sdk/s3-request-presigner";
import { S3Error } from "@cap/web-domain";
import type { RequestPresigningArguments } from "@smithy/types";
import { type Cause, Effect, Option, Stream } from "effect";

import { S3BucketClientProvider } from "./S3BucketClientProvider.ts";

const wrapS3Promise = <T>(
	promise: Promise<T> | Effect.Effect<Promise<T>, Cause.UnknownException>,
): Effect.Effect<T, S3Error, never> =>
	Effect.gen(function* () {
		if (promise instanceof Promise) {
			return yield* Effect.tryPromise({
				try: () => promise,
				catch: (cause) => new S3Error({ cause }),
			});
		}

		return yield* promise.pipe(
			Effect.flatMap((cbResult) =>
				Effect.tryPromise({
					try: () => cbResult,
					catch: (cause) => new S3Error({ cause }),
				}).pipe(Effect.tapError(Effect.logError)),
			),
		);
	}).pipe(
		Effect.catchTag("UnknownException", (cause) => new S3Error({ cause })),
	);

export const createS3BucketAccess = Effect.gen(function* () {
	const provider = yield* S3BucketClientProvider;
	return {
		bucketName: provider.bucket,
		isPathStyle: provider.isPathStyle,
		getSignedObjectUrl: (key: string) =>
			wrapS3Promise(
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
		getInternalSignedObjectUrl: (key: string) =>
			wrapS3Promise(
				provider.getInternal.pipe(
					Effect.map((client) =>
						S3Presigner.getSignedUrl(
							client,
							new S3.GetObjectCommand({ Bucket: provider.bucket, Key: key }),
							{ expiresIn: 3600 },
						),
					),
				),
			).pipe(Effect.withSpan("getInternalSignedObjectUrl")),
		getObject: (key: string) =>
			wrapS3Promise(
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
			wrapS3Promise(
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
			wrapS3Promise(
				provider.getInternal.pipe(
					Effect.map((client) =>
						client.send(
							new S3.HeadObjectCommand({ Bucket: provider.bucket, Key: key }),
						),
					),
				),
			),
		putObject: <E>(
			key: string,
			body: string | Uint8Array | ArrayBuffer | Stream.Stream<Uint8Array, E>,
			fields?: { contentType?: string; contentLength?: number },
		) =>
			wrapS3Promise(
				provider.getInternal.pipe(
					Effect.flatMap((client) =>
						Effect.gen(function* () {
							let _body: S3.PutObjectCommandInput["Body"];

							if (typeof body === "string" || body instanceof Uint8Array) {
								_body = body;
							} else if (body instanceof ArrayBuffer) {
								_body = new Uint8Array(body);
							} else {
								_body = body.pipe(
									Stream.toReadableStreamRuntime(yield* Effect.runtime()),
									(s) => Readable.fromWeb(s as any),
								);
							}

							return client.send(
								new S3.PutObjectCommand({
									Bucket: provider.bucket,
									Key: key,
									Body: _body,
									ContentType: fields?.contentType,
									ContentLength: fields?.contentLength,
								}),
							);
						}),
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
			wrapS3Promise(
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
			wrapS3Promise(
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
			wrapS3Promise(
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
			).pipe(Effect.when(() => objects.length > 0)),
		getPresignedPutUrl: (
			key: string,
			args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
			signingArgs?: RequestPresigningArguments,
		) =>
			wrapS3Promise(
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
		getInternalPresignedPutUrl: (
			key: string,
			args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
			signingArgs?: RequestPresigningArguments,
		) =>
			wrapS3Promise(
				provider.getInternal.pipe(
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
			wrapS3Promise(
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
				wrapS3Promise(
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
				wrapS3Promise(
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
								{ expiresIn: 3600 },
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
				wrapS3Promise(
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
			abort: (
				key: string,
				uploadId: string,
				args?: Omit<
					S3.AbortMultipartUploadCommandInput,
					"Key" | "Bucket" | "UploadId"
				>,
			) =>
				wrapS3Promise(
					provider.getInternal.pipe(
						Effect.map((client) =>
							client.send(
								new S3.AbortMultipartUploadCommand({
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
	};
});

export type S3BucketAccess = Effect.Effect.Success<typeof createS3BucketAccess>;
