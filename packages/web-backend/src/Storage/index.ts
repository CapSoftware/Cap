import type * as S3 from "@aws-sdk/client-s3";
import type * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	Storage as StorageDomain,
	type User,
	type Video,
} from "@cap/web-domain";
import { Effect, Option } from "effect";

import { S3Buckets } from "../S3Buckets/index.ts";
import type { S3BucketAccess } from "../S3Buckets/S3BucketAccess.ts";
import {
	copyGoogleDriveFile,
	createGoogleDriveResumableUpload,
	deleteGoogleDriveFile,
	findGoogleDriveFileByObjectKey,
	GOOGLE_DRIVE_FOLDER_MIME_TYPE,
	type GoogleDriveFile,
	type GoogleDriveTokenStore,
	getGoogleDriveFileMetadata,
	getGoogleDriveObjectResponse,
	getGoogleDriveObjectText,
	parseVideoIdFromObjectKey,
} from "./GoogleDrive.ts";
import { createStorageObjectToken } from "./SignedObject.ts";
import type { GoogleDriveIntegrationConfig } from "./StorageRepo.ts";
import { StorageRepo } from "./StorageRepo.ts";

type UploadTargetInput = {
	contentType: string;
	contentLength?: number;
	fields?: Record<string, string>;
	method?: "post" | "put";
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
							cause: new Error(`Storage object not found: ${key}`),
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
	) => mapStorageError(s3.copyObject(source, key, args)).pipe(Effect.asVoid),
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
	multipart: {
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
	},
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
								cause: new Error(`Google Drive object not found: ${key}`),
							}),
						),
					onSome: (file) => {
						const videoId = parseObjectKeyVideoId(key);
						const contentType = file.mimeType ?? previous.contentType;
						return mapStorageError(
							repo.upsertObject({
								integrationId,
								ownerId,
								videoId,
								objectKey: key,
								providerObjectId: file.id,
								uploadStatus: "complete",
								contentType,
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
						).pipe(Effect.as(file.id));
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
			Effect.catchTag("StorageError", () =>
				recoverDriveFileId(key, object).pipe(Effect.flatMap(read)),
			),
		);

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
			getObjectRecord(key).pipe(
				Effect.flatMap((object) =>
					withRecoveredDriveFile(key, object, (fileId) =>
						getGoogleDriveObjectText(config, fileId, tokenStore),
					),
				),
				Effect.map(Option.some),
				Effect.catchTag("StorageError", () => Effect.succeed(Option.none())),
			),
		listObjects: (input: {
			prefix?: string;
			maxKeys?: number;
			continuationToken?: string;
		}) =>
			mapStorageError(
				repo.listObjectsByPrefix(integrationId, input.prefix, input.maxKeys),
			).pipe(
				Effect.map((objects) => ({
					Contents: objects
						.filter(
							(object) =>
								object.contentType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE &&
								!object.objectKey.startsWith(".cap-folders/") &&
								!object.objectKey.startsWith(".cap-warnings/"),
						)
						.map((object) => ({
							Key: object.objectKey,
							Size: object.contentLength ?? undefined,
						})),
					KeyCount: objects.filter(
						(object) =>
							object.contentType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE &&
							!object.objectKey.startsWith(".cap-folders/") &&
							!object.objectKey.startsWith(".cap-warnings/"),
					).length,
					IsTruncated: false,
					NextContinuationToken: undefined,
				})),
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
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(uploadUrl, {
							method: "PUT",
							headers: getGoogleDriveUploadHeaders(contentType, contentLength),
							body,
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
		copyObject: (
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
							videoId: parseVideoIdFromObjectKey(key).pipe(
								Option.map((id) => id as Video.VideoId),
								Option.getOrNull,
							),
							key,
							contentType:
								(args?.ContentType as string | undefined) ??
								sourceObject.contentType ??
								"application/octet-stream",
						},
						tokenStore,
					}).pipe(mapStorageError),
				),
			),
		deleteObject: (key: string) =>
			getObjectRecord(key).pipe(
				Effect.flatMap((object) =>
					deleteGoogleDriveFile(
						config,
						object.providerObjectId,
						tokenStore,
					).pipe(
						Effect.catchAll(() => Effect.void),
						Effect.flatMap(() =>
							mapStorageError(repo.deleteObjectByKey(integrationId, key)),
						),
					),
				),
				Effect.catchAll(() => Effect.void),
			),
		deleteObjects: (objects: Array<{ Key?: string }>) =>
			Effect.forEach(
				objects,
				(object) =>
					object.Key
						? getObjectRecord(object.Key).pipe(
								Effect.flatMap((record) =>
									deleteGoogleDriveFile(
										config,
										record.providerObjectId,
										tokenStore,
									).pipe(
										Effect.catchAll(() => Effect.void),
										Effect.flatMap(() =>
											mapStorageError(
												repo.deleteObjectByKey(
													integrationId,
													object.Key as string,
												),
											),
										),
									),
								),
								Effect.catchAll(() => Effect.void),
							)
						: Effect.void,
				{ concurrency: 3 },
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
		multipart: {
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
				_uploadId?: string,
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
				_uploadId?: string,
				_args?: Omit<
					S3.AbortMultipartUploadCommandInput,
					"Key" | "Bucket" | "UploadId"
				>,
			) =>
				mapStorageError(repo.deleteObjectByKey(integrationId, key)).pipe(
					Effect.as({}),
				),
		},
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

export class Storage extends Effect.Service<Storage>()("Storage", {
	effect: Effect.gen(function* () {
		const repo = yield* StorageRepo;
		const s3Buckets = yield* S3Buckets;

		const getS3WritableAccessForUser = Effect.fn(
			"Storage.getS3WritableAccessForUser",
		)(function* (userId: User.UserId) {
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

		const getWritableAccessForUser = Effect.fn(
			"Storage.getWritableAccessForUser",
		)(function* (userId: User.UserId) {
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
		) {
			if (Option.isSome(video.storageIntegrationId)) {
				const access = yield* getDriveAccess(video.storageIntegrationId.value);
				return [access, Option.none()] as const;
			}

			const [s3, customBucket] = yield* mapStorageError(
				s3Buckets.getBucketAccess(video.bucketId),
			);
			return [makeS3Access(s3), customBucket] as const;
		});

		const createUploadTargetForUser = Effect.fn(
			"Storage.createUploadTargetForUser",
		)(function* (userId: User.UserId, key: string, input: UploadTargetInput) {
			const writable = yield* getWritableAccessForUser(userId);
			const upload = yield* writable.access.createUploadTarget(key, input);
			return { ...writable, upload };
		});

		const createUploadTargetForVideo = Effect.fn(
			"Storage.createUploadTargetForVideo",
		)(function* (video: Video.Video, key: string, input: UploadTargetInput) {
			const [access] = yield* getAccessForVideo(video);
			return yield* access.createUploadTarget(key, input);
		});

		return {
			getS3WritableAccessForUser,
			getWritableAccessForUser,
			getAccessForVideo,
			createUploadTargetForUser,
			createUploadTargetForVideo,
		};
	}),
	dependencies: [StorageRepo.Default, S3Buckets.Default],
}) {
	static getWritableAccessForUser = (userId: User.UserId) =>
		Effect.flatMap(Storage, (storage) =>
			storage.getWritableAccessForUser(userId),
		);
	static getS3WritableAccessForUser = (userId: User.UserId) =>
		Effect.flatMap(Storage, (storage) =>
			storage.getS3WritableAccessForUser(userId),
		);
	static getAccessForVideo = (video: Video.Video) =>
		Effect.flatMap(Storage, (storage) => storage.getAccessForVideo(video));
	static createUploadTargetForUser = (
		userId: User.UserId,
		key: string,
		input: UploadTargetInput,
	) =>
		Effect.flatMap(Storage, (storage) =>
			storage.createUploadTargetForUser(userId, key, input),
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
