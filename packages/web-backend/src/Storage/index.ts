import type * as S3 from "@aws-sdk/client-s3";
import type * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	type Organisation,
	type S3Bucket,
	Storage as StorageDomain,
	type User,
	type Video,
} from "@cap/web-domain";
import { Effect, Exit, Option } from "effect";

import { S3Buckets } from "../S3Buckets/index.ts";
import type { S3BucketAccess } from "../S3Buckets/S3BucketAccess.ts";
import {
	copyGoogleDriveFile,
	createGoogleDriveResumableUpload,
	deleteGoogleDriveFile,
	findGoogleDriveFileByObjectKey,
	GOOGLE_DRIVE_FOLDER_MIME_TYPE,
	type GoogleDriveFile,
	GoogleDriveRequestError,
	type GoogleDriveTokenStore,
	getGoogleDriveFileMetadata,
	getGoogleDriveObjectResponse,
	getGoogleDriveObjectText,
	parseVideoIdFromObjectKey,
	syncGoogleDriveVideoNames,
} from "./GoogleDrive.ts";
import { resolveRecordingObjectKey } from "./recording-output.ts";
import { createStorageObjectToken } from "./SignedObject.ts";
import type { GoogleDriveIntegrationConfig } from "./StorageRepo.ts";
import { StorageRepo } from "./StorageRepo.ts";

type UploadTargetInput = {
	contentType: string;
	contentLength?: number;
	fields?: Record<string, string>;
	method?: "post" | "put";
	videoTitle?: string;
};

type MultipartAccess = {
	copyPart?: (
		key: string,
		uploadId: string,
		partNumber: number,
		args: Omit<
			S3.UploadPartCopyCommandInput,
			"Key" | "Bucket" | "UploadId" | "PartNumber"
		>,
	) => Effect.Effect<
		S3.UploadPartCopyCommandOutput,
		StorageDomain.StorageError
	>;
	create: (
		key: string,
		args?: Omit<S3.CreateMultipartUploadCommandInput, "Bucket" | "Key">,
	) => Effect.Effect<{ UploadId?: string }, StorageDomain.StorageError>;
	getPresignedUploadPartUrl: (
		key: string,
		uploadId: string,
		partNumber: number,
		args?: Omit<
			S3.UploadPartCommandInput,
			"Key" | "Bucket" | "PartNumber" | "UploadId"
		>,
	) => Effect.Effect<string, StorageDomain.StorageError>;
	complete: (
		key: string,
		uploadId: string,
		args?: Omit<
			S3.CompleteMultipartUploadCommandInput,
			"Key" | "Bucket" | "UploadId"
		>,
	) => Effect.Effect<
		{ Location?: string; ETag?: string },
		StorageDomain.StorageError
	>;
	abort: (
		key: string,
		uploadId: string,
		args?: Omit<
			S3.AbortMultipartUploadCommandInput,
			"Key" | "Bucket" | "UploadId"
		>,
	) => Effect.Effect<unknown, StorageDomain.StorageError>;
};

const toS3UploadTarget = (data: {
	url: string;
	fields: Record<string, string>;
}): StorageDomain.UploadTarget => ({
	type: "s3Post",
	url: data.url,
	fields: data.fields,
});

const toPutUploadTarget = (
	url: string,
	contentType: string,
): StorageDomain.UploadTarget => ({
	type: "put",
	url,
	headers: {
		"Content-Type": contentType,
	},
});

const toDriveUploadTarget = (
	url: string,
	contentType: string,
): StorageDomain.UploadTarget => ({
	type: "driveResumable",
	url,
	headers: {
		"Content-Type": contentType,
	},
});

const getGoogleDriveUploadHeaders = (
	contentType: string,
	contentLength: number,
) => ({
	"Content-Type": contentType,
	"Content-Length": contentLength.toString(),
	...(contentLength > 0
		? {
				"Content-Range": `bytes 0-${contentLength - 1}/${contentLength}`,
			}
		: {}),
});

const parseSourceKey = (source: string) => {
	const parts = source.split("/");
	return parts.length > 1 ? parts.slice(1).join("/") : source;
};

const requireDriveObject = (
	repo: StorageRepo,
	integrationId: StorageDomain.StorageIntegrationId,
	key: string,
) =>
	repo.getObjectByKey(integrationId, key).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.fail(
						new StorageDomain.StorageError({
							cause: new GoogleDriveRequestError(
								404,
								`Storage object not found: ${key}`,
							),
						}),
					),
				onSome: Effect.succeed,
			}),
		),
	);

const createDriveObjectUrl = (key: string, ttlSeconds = 3600) =>
	parseVideoIdFromObjectKey(key).pipe(
		Option.match({
			onNone: () =>
				Effect.fail(
					new StorageDomain.StorageError({
						cause: new Error(`Could not resolve video id from key: ${key}`),
					}),
				),
			onSome: (videoId) =>
				Effect.sync(() => {
					const token = createStorageObjectToken({ videoId, key }, ttlSeconds);
					const params = new URLSearchParams({ videoId, key, token });
					return `${serverEnv().WEB_URL}/api/storage/object?${params.toString()}`;
				}),
		}),
	);

const mapStorageError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError((cause) => new StorageDomain.StorageError({ cause })),
	);

const makeS3MultipartAccess = (s3: S3BucketAccess): MultipartAccess => ({
	copyPart: (key, uploadId, partNumber, args) =>
		mapStorageError(s3.multipart.copyPart(key, uploadId, partNumber, args)),
	create: (
		key: string,
		args?: Omit<S3.CreateMultipartUploadCommandInput, "Bucket" | "Key">,
	) => mapStorageError(s3.multipart.create(key, args)),
	getPresignedUploadPartUrl: (
		key: string,
		uploadId: string,
		partNumber: number,
		args?: Omit<
			S3.UploadPartCommandInput,
			"Key" | "Bucket" | "PartNumber" | "UploadId"
		>,
	) =>
		mapStorageError(
			s3.multipart.getPresignedUploadPartUrl(key, uploadId, partNumber, args),
		),
	complete: (
		key: string,
		uploadId: string,
		args?: Omit<
			S3.CompleteMultipartUploadCommandInput,
			"Key" | "Bucket" | "UploadId"
		>,
	) => mapStorageError(s3.multipart.complete(key, uploadId, args)),
	abort: (
		key: string,
		uploadId: string,
		args?: Omit<
			S3.AbortMultipartUploadCommandInput,
			"Key" | "Bucket" | "UploadId"
		>,
	) => mapStorageError(s3.multipart.abort(key, uploadId, args)),
});

const makeGoogleDriveTokenStore = (
	repo: StorageRepo,
	integration: typeof Db.storageIntegrations.$inferSelect,
): GoogleDriveTokenStore => ({
	cacheKey: integration.id,
	getInitialAccessTokenCache: () =>
		mapStorageError(repo.getGoogleDriveAccessTokenCache(integration)),
	getAccessTokenCache: () =>
		mapStorageError(repo.getGoogleDriveAccessTokenCacheById(integration.id)),
	claimRefreshLease: (leaseId, expiresAt) =>
		mapStorageError(
			repo.claimGoogleDriveTokenRefreshLease(
				integration.id,
				leaseId,
				expiresAt,
			),
		),
	saveAccessTokenCache: (leaseId, cache) =>
		mapStorageError(
			repo.saveGoogleDriveAccessTokenCache(integration.id, leaseId, cache),
		),
	releaseRefreshLease: (leaseId) =>
		mapStorageError(
			repo.releaseGoogleDriveTokenRefreshLease(integration.id, leaseId),
		),
});

const recordingCopyMetadata = (metadata: {
	ContentLength?: number;
	ETag?: string;
}) => {
	const fileSize = metadata.ContentLength;
	const objectIdentity = metadata.ETag;
	if (
		fileSize === undefined ||
		!Number.isSafeInteger(fileSize) ||
		fileSize < 0 ||
		!objectIdentity ||
		!/^"[\x21\x23-\x7e]+"$/.test(objectIdentity)
	) {
		return Effect.fail(
			new StorageDomain.StorageError({
				cause: new Error(
					"Recording copy requires a stable source identity and size",
				),
			}),
		);
	}
	return Effect.succeed({ fileSize, objectIdentity });
};

const copyS3ObjectForRecording = (
	s3: S3BucketAccess,
	source: string,
	key: string,
) =>
	Effect.gen(function* () {
		const prefix = `${s3.bucketName}/`;
		if (!source.startsWith(prefix) || source.slice(prefix.length) === key) {
			return yield* Effect.fail(
				new StorageDomain.StorageError({
					cause: new Error(
						"Recording copy requires a distinct object in the same bucket",
					),
				}),
			);
		}
		const sourceKey = source.slice(prefix.length);
		const sourceMetadata = yield* s3.headObject(sourceKey);
		const { fileSize, objectIdentity } =
			yield* recordingCopyMetadata(sourceMetadata);
		const copySource = `${prefix}${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
		const singleCopyLimit = 5 * 1024 ** 3;
		const copiedIdentity = yield* fileSize <= singleCopyLimit
			? s3
					.copyObject(copySource, key, { CopySourceIfMatch: objectIdentity })
					.pipe(Effect.map((result) => result.CopyObjectResult?.ETag))
			: Effect.acquireUseRelease(
					s3.multipart
						.create(key, {
							ContentType: sourceMetadata.ContentType,
							CacheControl: sourceMetadata.CacheControl,
							ContentDisposition: sourceMetadata.ContentDisposition,
							ContentEncoding: sourceMetadata.ContentEncoding,
							ContentLanguage: sourceMetadata.ContentLanguage,
							Expires: sourceMetadata.Expires,
							Metadata: sourceMetadata.Metadata,
						})
						.pipe(
							Effect.flatMap((upload) =>
								upload.UploadId
									? Effect.succeed(upload.UploadId)
									: Effect.fail(
											new StorageDomain.StorageError({
												cause: new Error(
													"Recording multipart copy did not return an upload id",
												),
											}),
										),
							),
						),
					(uploadId) =>
						Effect.gen(function* () {
							const partSize = Math.max(
								128 * 1024 ** 2,
								Math.ceil(fileSize / 10_000),
							);
							if (partSize > singleCopyLimit) {
								return yield* Effect.fail(
									new StorageDomain.StorageError({
										cause: new Error("Recording exceeds multipart copy limits"),
									}),
								);
							}
							const parts = yield* Effect.forEach(
								Array.from(
									{ length: Math.ceil(fileSize / partSize) },
									(_, index) => index,
								),
								(index) =>
									Effect.gen(function* () {
										const start = index * partSize;
										const result = yield* s3.multipart.copyPart(
											key,
											uploadId,
											index + 1,
											{
												CopySource: copySource,
												CopySourceIfMatch: objectIdentity,
												CopySourceRange: `bytes=${start}-${Math.min(fileSize, start + partSize) - 1}`,
											},
										);
										const etag = result.CopyPartResult?.ETag;
										if (!etag) {
											return yield* Effect.fail(
												new StorageDomain.StorageError({
													cause: new Error(
														"Recording multipart copy returned an incomplete part",
													),
												}),
											);
										}
										return { PartNumber: index + 1, ETag: etag };
									}),
								{ concurrency: 3 },
							);
							const result = yield* s3.multipart.complete(key, uploadId, {
								MultipartUpload: { Parts: parts },
								IfNoneMatch: "*",
							});
							return result.ETag;
						}),
					(uploadId, exit) =>
						Exit.isFailure(exit)
							? s3.multipart.abort(key, uploadId).pipe(
									Effect.catchAll(() =>
										Effect.logWarning("Recording multipart copy abort failed"),
									),
									Effect.asVoid,
								)
							: Effect.void,
				);
		const [currentSource, currentDestination] = yield* Effect.all([
			s3.headObject(sourceKey),
			s3.headObject(key),
		]);
		yield* recordingCopyMetadata(currentDestination);
		if (
			currentSource.ContentLength !== fileSize ||
			currentSource.ETag !== objectIdentity ||
			!copiedIdentity ||
			currentDestination.ContentLength !== fileSize ||
			currentDestination.ETag !== copiedIdentity
		) {
			return yield* Effect.fail(
				new StorageDomain.StorageError({
					cause: new Error(
						"Recording copy changed during transfer or failed readback",
					),
				}),
			);
		}
	}).pipe(mapStorageError);

const makeS3Access = (s3: S3BucketAccess) => ({
	provider: "s3" as const,
	bucketName: s3.bucketName,
	isPathStyle: s3.isPathStyle,
	getSignedObjectUrl: (
		key: string,
		signingArgs?: Parameters<S3BucketAccess["getSignedObjectUrl"]>[1],
	) => mapStorageError(s3.getSignedObjectUrl(key, signingArgs)),
	getInternalSignedObjectUrl: (
		key: string,
		signingArgs?: Parameters<S3BucketAccess["getInternalSignedObjectUrl"]>[1],
	) => mapStorageError(s3.getInternalSignedObjectUrl(key, signingArgs)),
	getObject: (key: string) => mapStorageError(s3.getObject(key)),
	listObjects: (input: {
		prefix?: string;
		maxKeys?: number;
		continuationToken?: string;
	}) =>
		mapStorageError(s3.listObjects(input)).pipe(
			Effect.map((result) => ({
				Contents: result.Contents?.map((object) => ({
					Key: object.Key,
					Size: object.Size,
					LastModified: object.LastModified,
				})),
				KeyCount: result.KeyCount,
				IsTruncated: result.IsTruncated,
				NextContinuationToken: result.NextContinuationToken,
			})),
		),
	headObject: (key: string) =>
		mapStorageError(s3.headObject(key)).pipe(
			Effect.map((result) => ({
				ContentLength: result.ContentLength,
				ContentType: result.ContentType,
				Metadata: result.Metadata,
				ETag: result.ETag,
			})),
		),
	putObject: (
		key: string,
		body: Parameters<S3BucketAccess["putObject"]>[1],
		fields?: Parameters<S3BucketAccess["putObject"]>[2],
	) => mapStorageError(s3.putObject(key, body, fields)).pipe(Effect.asVoid),
	copyObject: (
		source: string,
		key: string,
		args?: Omit<S3.CopyObjectCommandInput, "Bucket" | "CopySource" | "Key">,
	) => mapStorageError(s3.copyObject(source, key, args)),
	copyObjectForRecording: (source: string, key: string) =>
		copyS3ObjectForRecording(s3, source, key),
	deleteObject: (key: string) =>
		mapStorageError(s3.deleteObject(key)).pipe(Effect.asVoid),
	deleteObjects: (objects: Array<{ Key?: string }>) =>
		mapStorageError(
			s3.deleteObjects(
				objects
					.filter((object): object is { Key: string } => Boolean(object.Key))
					.map((object) => ({ Key: object.Key })),
			),
		).pipe(Effect.asVoid),
	getPresignedPutUrl: (
		key: string,
		args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
		signingArgs?: Parameters<S3BucketAccess["getPresignedPutUrl"]>[2],
	) => mapStorageError(s3.getPresignedPutUrl(key, args, signingArgs)),
	getInternalPresignedPutUrl: (
		key: string,
		args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
		signingArgs?: Parameters<S3BucketAccess["getInternalPresignedPutUrl"]>[2],
	) => mapStorageError(s3.getInternalPresignedPutUrl(key, args, signingArgs)),
	getPresignedPostUrl: (
		key: string,
		args: Parameters<S3BucketAccess["getPresignedPostUrl"]>[1],
	) => mapStorageError(s3.getPresignedPostUrl(key, args)),
	multipart: makeS3MultipartAccess(s3),
	createUploadTarget: (key: string, input: UploadTargetInput) =>
		Effect.gen(function* () {
			if (input.method === "put") {
				const url = yield* s3
					.getPresignedPutUrl(
						key,
						{ ContentType: input.contentType },
						{ expiresIn: 1800 },
					)
					.pipe(mapStorageError);
				return toPutUploadTarget(url, input.contentType);
			}

			const data = yield* s3
				.getPresignedPostUrl(key, {
					Fields: {
						"Content-Type": input.contentType,
						...(input.fields ?? {}),
					},
					Expires: 1800,
				})
				.pipe(mapStorageError);
			return toS3UploadTarget(data);
		}),
});

const parseGoogleDriveContentLength = (file: GoogleDriveFile) => {
	if (!file.size) return null;
	const contentLength = Number(file.size);
	return Number.isFinite(contentLength) ? contentLength : null;
};

const parseObjectKeyVideoId = (key: string) =>
	parseVideoIdFromObjectKey(key).pipe(
		Option.map((id) => id as Video.VideoId),
		Option.getOrNull,
	);

const isMissingDriveObject = (error: StorageDomain.StorageError) =>
	error.cause instanceof GoogleDriveRequestError && error.cause.status === 404;

const makeGoogleDriveAccess = ({
	repo,
	integration,
	config,
}: {
	repo: StorageRepo;
	integration: typeof Db.storageIntegrations.$inferSelect;
	config: GoogleDriveIntegrationConfig;
}) => {
	const integrationId = integration.id;
	const ownerId = integration.ownerId;
	const tokenStore = makeGoogleDriveTokenStore(repo, integration);

	const getObjectRecord = (key: string) =>
		mapStorageError(requireDriveObject(repo, integrationId, key));
	const recoverDriveFileId = (
		key: string,
		previous: typeof Db.storageObjects.$inferSelect,
	) =>
		findGoogleDriveFileByObjectKey(config, key, tokenStore).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Effect.fail(
							new StorageDomain.StorageError({
								cause: new GoogleDriveRequestError(
									404,
									`Object not found: ${key}`,
								),
							}),
						),
					onSome: (file) => {
						if (
							file.id !== previous.providerObjectId &&
							previous.uploadStatus !== "complete"
						) {
							return Effect.fail(
								new StorageDomain.StorageError({
									cause: new Error(
										"Cannot replace a Google Drive upload that is not complete",
									),
								}),
							);
						}
						const videoId = parseObjectKeyVideoId(key);
						const contentType = file.mimeType ?? previous.contentType;
						return mapStorageError(
							repo.updateObjectIfCurrent(previous, {
								providerObjectId: file.id,
								uploadStatus: "complete",
								contentType,
								preserveMetadata: true,
								contentLength:
									parseGoogleDriveContentLength(file) ??
									previous.contentLength ??
									null,
								metadata: {
									...(previous.metadata ?? {}),
									videoId: videoId ?? previous.metadata?.videoId,
									fileName: file.name ?? previous.metadata?.fileName,
									contentType: file.mimeType ?? previous.metadata?.contentType,
								},
							}),
						).pipe(
							Effect.flatMap((saved) =>
								saved
									? Effect.succeed(file.id)
									: Effect.fail(
											new StorageDomain.StorageError({
												cause: new Error(
													"Storage object changed during Google Drive recovery; retry",
												),
											}),
										),
							),
						);
					},
				}),
			),
		);
	const withRecoveredDriveFile = <A>(
		key: string,
		object: typeof Db.storageObjects.$inferSelect,
		read: (fileId: string) => Effect.Effect<A, StorageDomain.StorageError>,
	) =>
		read(object.providerObjectId).pipe(
			Effect.catchTag("StorageError", (error) =>
				isMissingDriveObject(error)
					? recoverDriveFileId(key, object).pipe(Effect.flatMap(read))
					: Effect.fail(error),
			),
		);
	const copyObject = (
		source: string,
		key: string,
		args?: Omit<S3.CopyObjectCommandInput, "Bucket" | "CopySource" | "Key">,
	) =>
		getObjectRecord(parseSourceKey(source)).pipe(
			Effect.flatMap((sourceObject) =>
				copyGoogleDriveFile({
					repo,
					config,
					sourceFileId: sourceObject.providerObjectId,
					input: {
						integrationId,
						ownerId,
						videoId: parseObjectKeyVideoId(key),
						key,
						contentType:
							args?.ContentType ??
							sourceObject.contentType ??
							"application/octet-stream",
					},
					tokenStore,
				}).pipe(mapStorageError),
			),
		);
	const deleteObject = (key: string) =>
		Effect.gen(function* () {
			const stored = yield* mapStorageError(
				repo.getObjectByKey(integrationId, key),
			);
			if (Option.isNone(stored)) return;
			yield* deleteGoogleDriveFile(
				config,
				stored.value.providerObjectId,
				tokenStore,
			).pipe(
				Effect.catchAll((error) =>
					isMissingDriveObject(error) ? Effect.void : Effect.fail(error),
				),
			);
			yield* mapStorageError(
				repo.deleteObjectByKey(
					integrationId,
					key,
					stored.value.providerObjectId,
				),
			);
		});
	const copyObjectForRecording = (source: string, key: string) =>
		Effect.gen(function* () {
			const sourceKey = parseSourceKey(source);
			if (!source.startsWith("google-drive/") || sourceKey === key) {
				return yield* Effect.fail(
					new StorageDomain.StorageError({
						cause: new Error(
							"Recording copy requires a distinct object in the same storage integration",
						),
					}),
				);
			}
			const sourceObject = yield* getObjectRecord(sourceKey);
			const before = yield* withRecoveredDriveFile(
				sourceKey,
				sourceObject,
				(fileId) => getGoogleDriveFileMetadata(config, fileId, tokenStore),
			);
			const { fileSize } = yield* recordingCopyMetadata({
				ContentLength: parseGoogleDriveContentLength(before) ?? undefined,
				ETag:
					before.id && before.version
						? `"${before.id}:${before.version}"`
						: undefined,
			});
			yield* copyGoogleDriveFile({
				repo,
				config,
				sourceFileId: before.id,
				input: {
					integrationId,
					ownerId,
					videoId: parseObjectKeyVideoId(key),
					key,
					contentType:
						before.mimeType ??
						sourceObject.contentType ??
						"application/octet-stream",
				},
				tokenStore,
			}).pipe(mapStorageError);
			const currentSource = yield* getObjectRecord(sourceKey);
			const destination = yield* getObjectRecord(key);
			const [after, copied] = yield* Effect.all([
				getGoogleDriveFileMetadata(config, before.id, tokenStore),
				getGoogleDriveFileMetadata(
					config,
					destination.providerObjectId,
					tokenStore,
				),
			]);
			yield* recordingCopyMetadata({
				ContentLength: parseGoogleDriveContentLength(copied) ?? undefined,
				ETag:
					copied.id && copied.version
						? `"${copied.id}:${copied.version}"`
						: undefined,
			});
			if (
				currentSource.providerObjectId !== before.id ||
				after.id !== before.id ||
				after.version !== before.version ||
				parseGoogleDriveContentLength(after) !== fileSize ||
				parseGoogleDriveContentLength(copied) !== fileSize
			) {
				return yield* Effect.fail(
					new StorageDomain.StorageError({
						cause: new Error(
							"Recording copy changed during transfer or failed readback",
						),
					}),
				);
			}
		});

	const multipart: MultipartAccess = {
		create: (
			key: string,
			args?: Omit<S3.CreateMultipartUploadCommandInput, "Bucket" | "Key">,
		) =>
			createGoogleDriveResumableUpload(
				repo,
				config,
				{
					integrationId,
					ownerId,
					videoId: parseVideoIdFromObjectKey(key).pipe(
						Option.map((id) => id as Video.VideoId),
						Option.getOrNull,
					),
					key,
					contentType: args?.ContentType ?? "application/octet-stream",
				},
				tokenStore,
			).pipe(
				mapStorageError,
				Effect.map((UploadId) => ({ UploadId })),
			),
		getPresignedUploadPartUrl: (
			_key: string,
			uploadId: string,
			_partNumber: number,
			_args?: Omit<
				S3.UploadPartCommandInput,
				"Key" | "Bucket" | "PartNumber" | "UploadId"
			>,
		) => Effect.succeed(uploadId),
		complete: (
			key: string,
			_uploadId: string,
			args?: Omit<
				S3.CompleteMultipartUploadCommandInput,
				"Key" | "Bucket" | "UploadId"
			>,
		) =>
			getObjectRecord(key).pipe(
				Effect.flatMap(() =>
					mapStorageError(
						repo.markObjectComplete(integrationId, key, args?.MpuObjectSize),
					),
				),
				Effect.flatMap(() => createDriveObjectUrl(key)),
				Effect.map((Location) => ({ Location })),
			),
		abort: (
			key: string,
			_uploadId: string,
			_args?: Omit<
				S3.AbortMultipartUploadCommandInput,
				"Key" | "Bucket" | "UploadId"
			>,
		) =>
			mapStorageError(repo.deleteObjectByKey(integrationId, key)).pipe(
				Effect.as({}),
			),
	};

	return {
		provider: "googleDrive" as const,
		bucketName: "google-drive",
		isPathStyle: false,
		getSignedObjectUrl: (
			key: string,
			signingArgs?: Parameters<S3BucketAccess["getSignedObjectUrl"]>[1],
		) => createDriveObjectUrl(key, signingArgs?.expiresIn),
		getInternalSignedObjectUrl: (
			key: string,
			signingArgs?: Parameters<S3BucketAccess["getInternalSignedObjectUrl"]>[1],
		) => createDriveObjectUrl(key, signingArgs?.expiresIn ?? 7200),
		getObject: (key: string) =>
			Effect.gen(function* () {
				const object = yield* mapStorageError(
					repo.getObjectByKey(integrationId, key),
				);
				if (Option.isNone(object)) return Option.none<string>();
				return yield* withRecoveredDriveFile(key, object.value, (fileId) =>
					getGoogleDriveObjectText(config, fileId, tokenStore),
				).pipe(
					Effect.map(Option.some),
					Effect.catchTag("StorageError", (error) =>
						isMissingDriveObject(error)
							? Effect.succeed(Option.none<string>())
							: Effect.fail(error),
					),
				);
			}),
		listObjects: (input: {
			prefix?: string;
			maxKeys?: number;
			continuationToken?: string;
		}) =>
			mapStorageError(
				repo.listObjectsByPrefix(
					integrationId,
					input.prefix,
					input.maxKeys,
					input.continuationToken,
				),
			).pipe(
				Effect.map(({ objects, nextContinuationToken }) => {
					const contents = objects
						.filter(
							(object) =>
								object.contentType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE &&
								!object.objectKey.startsWith(".cap-folders/") &&
								!object.objectKey.startsWith(".cap-warnings/"),
						)
						.map((object) => ({
							Key: object.objectKey,
							Size: object.contentLength ?? undefined,
							LastModified: object.updatedAt,
						}));
					return {
						Contents: contents,
						KeyCount: contents.length,
						IsTruncated: nextContinuationToken !== undefined,
						NextContinuationToken: nextContinuationToken,
					};
				}),
			),
		headObject: (key: string) =>
			getObjectRecord(key).pipe(
				Effect.flatMap((object) =>
					withRecoveredDriveFile(key, object, (fileId) =>
						getGoogleDriveFileMetadata(config, fileId, tokenStore),
					).pipe(
						Effect.map((metadata) => ({
							ContentLength: metadata.size
								? Number(metadata.size)
								: (object.contentLength ?? undefined),
							ContentType: metadata.mimeType ?? object.contentType ?? undefined,
							Metadata: object.metadata ?? undefined,
							ETag: metadata.version
								? `"${metadata.id}:${metadata.version}"`
								: undefined,
						})),
					),
				),
			),
		putObject: (
			key: string,
			body: string | Uint8Array | ArrayBuffer,
			fields?: { contentType?: string; contentLength?: number },
		) =>
			Effect.gen(function* () {
				const contentType = fields?.contentType ?? "application/octet-stream";
				const contentLength =
					fields?.contentLength ??
					(typeof body === "string"
						? new TextEncoder().encode(body).byteLength
						: body.byteLength);
				const uploadUrl = yield* createGoogleDriveResumableUpload(
					repo,
					config,
					{
						integrationId,
						ownerId,
						videoId: parseVideoIdFromObjectKey(key).pipe(
							Option.map((id) => id as Video.VideoId),
							Option.getOrNull,
						),
						key,
						contentType,
						contentLength,
					},
					tokenStore,
				).pipe(mapStorageError);
				const uploadBody =
					body instanceof Uint8Array ? new Uint8Array(body).buffer : body;
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(uploadUrl, {
							method: "PUT",
							headers: getGoogleDriveUploadHeaders(contentType, contentLength),
							body: uploadBody,
						}),
					catch: (cause) => new StorageDomain.StorageError({ cause }),
				});
				if (!response.ok) {
					return yield* Effect.fail(
						new StorageDomain.StorageError({
							cause: new Error(
								`Google Drive upload failed: ${response.status}`,
							),
						}),
					);
				}
				yield* mapStorageError(
					repo.markObjectComplete(integrationId, key, contentLength),
				);
			}),
		copyObject,
		copyObjectForRecording,
		deleteObject,
		deleteObjects: (objects: Array<{ Key?: string }>) =>
			Effect.forEach(
				objects,
				(object) => (object.Key ? deleteObject(object.Key) : Effect.void),
				{ concurrency: 3, discard: true },
			),
		getPresignedPutUrl: (
			key: string,
			args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
		) =>
			createGoogleDriveResumableUpload(
				repo,
				config,
				{
					integrationId,
					ownerId,
					videoId: parseVideoIdFromObjectKey(key).pipe(
						Option.map((id) => id as Video.VideoId),
						Option.getOrNull,
					),
					key,
					contentType: args?.ContentType ?? "application/octet-stream",
					contentLength: args?.ContentLength,
				},
				tokenStore,
			).pipe(mapStorageError),
		getInternalPresignedPutUrl: (
			key: string,
			args?: Omit<S3.PutObjectRequest, "Key" | "Bucket">,
		) =>
			createGoogleDriveResumableUpload(
				repo,
				config,
				{
					integrationId,
					ownerId,
					videoId: parseVideoIdFromObjectKey(key).pipe(
						Option.map((id) => id as Video.VideoId),
						Option.getOrNull,
					),
					key,
					contentType: args?.ContentType ?? "application/octet-stream",
					contentLength: args?.ContentLength,
				},
				tokenStore,
			).pipe(mapStorageError),
		getPresignedPostUrl: (key: string) =>
			Effect.fail(
				new StorageDomain.StorageError({
					cause: new Error(
						`Google Drive does not support POST uploads: ${key}`,
					),
				}),
			),
		multipart,
		createUploadTarget: (key: string, input: UploadTargetInput) =>
			createGoogleDriveResumableUpload(
				repo,
				config,
				{
					integrationId,
					ownerId,
					videoId: parseVideoIdFromObjectKey(key).pipe(
						Option.map((id) => id as Video.VideoId),
						Option.getOrNull,
					),
					key,
					contentType: input.contentType,
					contentLength: input.contentLength,
					videoTitle: input.videoTitle,
				},
				tokenStore,
			).pipe(
				mapStorageError,
				Effect.map((url) => toDriveUploadTarget(url, input.contentType)),
			),
		getObjectResponse: (key: string, range?: string | null) =>
			getObjectRecord(key).pipe(
				Effect.flatMap((object) =>
					withRecoveredDriveFile(key, object, (fileId) =>
						getGoogleDriveObjectResponse(config, fileId, range, tokenStore),
					),
				),
			),
	};
};

function withPublishedRecordingOutput<
	Access extends
		| ReturnType<typeof makeS3Access>
		| ReturnType<typeof makeGoogleDriveAccess>,
>(video: Video.Video, access: Access): Access {
	const resolve = (key: string) => resolveRecordingObjectKey(video, key);
	const resolveCopySource = (source: string) => {
		const prefix = `${access.bucketName}/`;
		return source.startsWith(prefix)
			? `${prefix}${resolve(source.slice(prefix.length))}`
			: source;
	};
	const shared = {
		...access,
		getObject: (key: string) => access.getObject(resolve(key)),
		headObject: (key: string) => access.headObject(resolve(key)),
		getSignedObjectUrl: (
			key: string,
			args?: Parameters<S3BucketAccess["getSignedObjectUrl"]>[1],
		) => access.getSignedObjectUrl(resolve(key), args),
		getInternalSignedObjectUrl: (
			key: string,
			args?: Parameters<S3BucketAccess["getInternalSignedObjectUrl"]>[1],
		) => access.getInternalSignedObjectUrl(resolve(key), args),
		copyObject: (
			source: string,
			key: string,
			args?: Omit<S3.CopyObjectCommandInput, "Bucket" | "CopySource" | "Key">,
		) => access.copyObject(resolveCopySource(source), key, args),
		copyObjectForRecording: (source: string, key: string) =>
			access.copyObjectForRecording(resolveCopySource(source), key),
	};
	if (access.provider === "googleDrive") {
		return Object.assign({}, access, shared, {
			getObjectResponse: (key: string, range?: string | null) =>
				access.getObjectResponse(resolve(key), range),
		});
	}
	return Object.assign({}, access, shared);
}

type WritableStorageAccess = {
	access:
		| ReturnType<typeof makeS3Access>
		| ReturnType<typeof makeGoogleDriveAccess>;
	bucketId: Option.Option<S3Bucket.S3BucketId>;
	storageIntegrationId: Option.Option<StorageDomain.StorageIntegrationId>;
};

export class Storage extends Effect.Service<Storage>()("Storage", {
	effect: Effect.gen(function* () {
		const repo = yield* StorageRepo;
		const s3Buckets = yield* S3Buckets;

		const getS3WritableAccessForUser = Effect.fn(
			"Storage.getS3WritableAccessForUser",
		)(function* (
			userId: User.UserId,
			organizationId?: Organisation.OrganisationId,
		) {
			if (organizationId) {
				const organizationBucket = yield* mapStorageError(
					s3Buckets.getBucketAccessForOrganization(organizationId),
				);

				if (Option.isSome(organizationBucket)) {
					const [s3, customBucket] = organizationBucket.value;
					return {
						access: makeS3Access(s3),
						bucketId: Option.map(customBucket, (bucket) => bucket.id),
						storageIntegrationId: Option.none(),
					};
				}
			}

			const [s3, customBucket] = yield* mapStorageError(
				s3Buckets.getBucketAccessForUser(userId),
			);
			return {
				access: makeS3Access(s3),
				bucketId: Option.map(customBucket, (bucket) => bucket.id),
				storageIntegrationId: Option.none(),
			};
		});

		const getDriveAccess = Effect.fn("Storage.getDriveAccess")(function* (
			integrationId: StorageDomain.StorageIntegrationId,
		) {
			const integration = yield* mapStorageError(
				repo.getIntegrationById(integrationId),
			).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(
								new StorageDomain.StorageError({
									cause: new Error("Storage integration not found"),
								}),
							),
						onSome: Effect.succeed,
					}),
				),
			);
			const config = yield* mapStorageError(
				repo.getGoogleDriveConfig(integration),
			);
			return makeGoogleDriveAccess({ repo, integration, config });
		});

		const getOrganizationWritableAccess = Effect.fn(
			"Storage.getOrganizationWritableAccess",
		)(function* (organizationId: Organisation.OrganisationId) {
			const activeIntegration = yield* mapStorageError(
				repo.getActiveIntegrationForOrganization(organizationId),
			);
			if (Option.isSome(activeIntegration)) {
				const access = yield* getDriveAccess(activeIntegration.value.id);
				return Option.some<WritableStorageAccess>({
					access,
					bucketId: Option.none(),
					storageIntegrationId: Option.some(activeIntegration.value.id),
				});
			}

			const organizationBucket = yield* mapStorageError(
				s3Buckets.getBucketAccessForOrganization(organizationId),
			);
			if (Option.isSome(organizationBucket)) {
				const [s3, customBucket] = organizationBucket.value;
				return Option.some<WritableStorageAccess>({
					access: makeS3Access(s3),
					bucketId: Option.map(customBucket, (bucket) => bucket.id),
					storageIntegrationId: Option.none(),
				});
			}

			return Option.none<WritableStorageAccess>();
		});

		const getWritableAccessForUser = Effect.fn(
			"Storage.getWritableAccessForUser",
		)(function* (
			userId: User.UserId,
			organizationId?: Organisation.OrganisationId,
		) {
			if (organizationId) {
				const organizationAccess =
					yield* getOrganizationWritableAccess(organizationId);

				if (Option.isSome(organizationAccess)) {
					return organizationAccess.value;
				}
			}

			const activeIntegration = yield* mapStorageError(
				repo.getActiveIntegrationForUser(userId),
			);
			if (Option.isSome(activeIntegration)) {
				const access = yield* getDriveAccess(activeIntegration.value.id);
				return {
					access,
					bucketId: Option.none(),
					storageIntegrationId: Option.some(activeIntegration.value.id),
				};
			}

			return yield* getS3WritableAccessForUser(userId);
		});

		const getAccessForVideo = Effect.fn("Storage.getAccessForVideo")(function* (
			video: Video.Video,
			options?: { resolvePublishedOutput?: boolean },
		) {
			if (Option.isSome(video.storageIntegrationId)) {
				const access = yield* getDriveAccess(video.storageIntegrationId.value);
				return [
					options?.resolvePublishedOutput === false
						? access
						: withPublishedRecordingOutput(video, access),
					Option.none(),
				] as const;
			}

			const [s3, customBucket] = yield* mapStorageError(
				s3Buckets.getBucketAccess(video.bucketId),
			);
			const access = makeS3Access(s3);
			return [
				options?.resolvePublishedOutput === false
					? access
					: withPublishedRecordingOutput(video, access),
				customBucket,
			] as const;
		});

		const createUploadTargetForUser = Effect.fn(
			"Storage.createUploadTargetForUser",
		)(function* (
			userId: User.UserId,
			key: string,
			input: UploadTargetInput,
			organizationId?: Organisation.OrganisationId,
		) {
			const writable = yield* getWritableAccessForUser(userId, organizationId);
			const upload = yield* writable.access.createUploadTarget(key, input);
			return { ...writable, upload };
		});

		const createUploadTargetForVideo = Effect.fn(
			"Storage.createUploadTargetForVideo",
		)(function* (video: Video.Video, key: string, input: UploadTargetInput) {
			const [access] = yield* getAccessForVideo(video);
			return yield* access.createUploadTarget(key, input);
		});

		const syncVideoDisplayNames = Effect.fn("Storage.syncVideoDisplayNames")(
			function* (videoId: Video.VideoId) {
				for (let attempt = 0; attempt < 3; attempt++) {
					const current = yield* mapStorageError(
						repo.getVideoForNameSync(videoId),
					);
					if (Option.isNone(current) || !current.value.storageIntegrationId)
						return;
					const video = current.value;
					const integrationId = current.value.storageIntegrationId;
					const integration = yield* mapStorageError(
						repo.getIntegrationById(integrationId),
					);
					if (Option.isNone(integration)) {
						return yield* Effect.fail(
							new StorageDomain.StorageError({
								cause: new Error("Storage integration not found"),
							}),
						);
					}
					const config = yield* mapStorageError(
						repo.getGoogleDriveConfig(integration.value),
					);
					const synced = yield* syncGoogleDriveVideoNames(
						repo,
						config,
						{ ...video, storageIntegrationId: integrationId },
						makeGoogleDriveTokenStore(repo, integration.value),
					);
					const latest = yield* mapStorageError(
						repo.getVideoForNameSync(videoId),
					);
					if (Option.isNone(latest)) return;
					if (
						synced &&
						latest.value.name === video.name &&
						latest.value.ownerId === video.ownerId &&
						latest.value.storageIntegrationId === integrationId
					)
						return;
				}
				return yield* Effect.fail(
					new StorageDomain.StorageError({
						cause: new Error(
							"Video changed during Google Drive name synchronization",
						),
					}),
				);
			},
		);

		return {
			getS3WritableAccessForUser,
			getOrganizationWritableAccess,
			getWritableAccessForUser,
			getAccessForVideo,
			createUploadTargetForUser,
			createUploadTargetForVideo,
			syncVideoDisplayNames,
		};
	}),
	dependencies: [StorageRepo.Default, S3Buckets.Default],
}) {
	static getWritableAccessForUser = (
		userId: User.UserId,
		organizationId?: Organisation.OrganisationId,
	) =>
		Effect.flatMap(Storage, (storage) =>
			storage.getWritableAccessForUser(userId, organizationId),
		);
	static getS3WritableAccessForUser = (
		userId: User.UserId,
		organizationId?: Organisation.OrganisationId,
	) =>
		Effect.flatMap(Storage, (storage) =>
			storage.getS3WritableAccessForUser(userId, organizationId),
		);
	static getOrganizationWritableAccess = (
		organizationId: Organisation.OrganisationId,
	) =>
		Effect.flatMap(Storage, (storage) =>
			storage.getOrganizationWritableAccess(organizationId),
		);
	static getAccessForVideo = (
		video: Video.Video,
		options?: { resolvePublishedOutput?: boolean },
	) =>
		Effect.flatMap(Storage, (storage) =>
			storage.getAccessForVideo(video, options),
		);
	static syncVideoDisplayNames = (videoId: Video.VideoId) =>
		Effect.flatMap(Storage, (storage) =>
			storage.syncVideoDisplayNames(videoId),
		);
	static createUploadTargetForUser = (
		userId: User.UserId,
		key: string,
		input: UploadTargetInput,
		organizationId?: Organisation.OrganisationId,
	) =>
		Effect.flatMap(Storage, (storage) =>
			storage.createUploadTargetForUser(userId, key, input, organizationId),
		);
	static createUploadTargetForVideo = (
		video: Video.Video,
		key: string,
		input: UploadTargetInput,
	) =>
		Effect.flatMap(Storage, (storage) =>
			storage.createUploadTargetForVideo(video, key, input),
		);
}
