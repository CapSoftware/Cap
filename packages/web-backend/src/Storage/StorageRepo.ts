import { createHash } from "node:crypto";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import {
	type Organisation,
	Storage,
	type User,
	type Video,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";

export const getObjectKeyHash = (key: string) =>
	createHash("sha256").update(key).digest("hex");

const escapeLikePattern = (value: string) =>
	value.replace(/[\\%_]/g, (match) => `\\${match}`);

export type GoogleDriveIntegrationConfig = {
	refreshToken: string;
	folderId: string;
	folderName?: string;
	driveId?: string | null;
	driveName?: string | null;
	folderLayout?: "video" | "userVideo";
	email?: string;
	scope?: string;
};

export type GoogleDriveStorageQuota = {
	limit?: string | null;
	usage?: string | null;
	usageInDrive?: string | null;
	usageInDriveTrash?: string | null;
};

export type GoogleDriveStorageQuotaCache = GoogleDriveStorageQuota & {
	fetchedAt: string;
};

export type GoogleDriveAccessTokenCache = {
	accessToken: string;
	expiresAt: Date;
};

export type StorageObjectInput = {
	integrationId: Storage.StorageIntegrationId;
	ownerId: User.UserId;
	videoId: Video.VideoId | null;
	objectKey: string;
	providerObjectId: string;
	uploadSessionUrl?: string | null;
	uploadStatus?: "pending" | "complete" | "error";
	contentType?: string | null;
	contentLength?: number | null;
	metadata?: Storage.StorageObjectMetadata | null;
};

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export class StorageRepo extends Effect.Service<StorageRepo>()("StorageRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		const decodeGoogleDriveAccessTokenCache = Effect.fn(
			"StorageRepo.decodeGoogleDriveAccessTokenCache",
		)(
			(input: {
				googleDriveAccessToken: string | null;
				googleDriveAccessTokenExpiresAt: Date | null;
			}) =>
				Effect.gen(function* () {
					if (
						!input.googleDriveAccessToken ||
						!input.googleDriveAccessTokenExpiresAt
					) {
						return Option.none<GoogleDriveAccessTokenCache>();
					}

					const accessToken = yield* Effect.tryPromise({
						try: () => decrypt(input.googleDriveAccessToken as string),
						catch: (cause) => new Storage.StorageError({ cause }),
					});

					return Option.some({
						accessToken,
						expiresAt: input.googleDriveAccessTokenExpiresAt,
					});
				}),
		);

		const getActiveIntegrationForUser = Effect.fn(
			"StorageRepo.getActiveIntegrationForUser",
		)((userId: User.UserId) =>
			Effect.gen(function* () {
				const [integration] = yield* db.use((db) =>
					db
						.select()
						.from(Db.storageIntegrations)
						.where(
							Dz.and(
								Dz.eq(Db.storageIntegrations.ownerId, userId),
								Dz.isNull(Db.storageIntegrations.organizationId),
								Dz.eq(Db.storageIntegrations.active, true),
								Dz.eq(Db.storageIntegrations.status, "active"),
							),
						),
				);

				return Option.fromNullable(integration);
			}),
		);

		const getActiveIntegrationForOrganization = Effect.fn(
			"StorageRepo.getActiveIntegrationForOrganization",
		)((organizationId: Organisation.OrganisationId) =>
			Effect.gen(function* () {
				const [integration] = yield* db.use((db) =>
					db
						.select()
						.from(Db.storageIntegrations)
						.where(
							Dz.and(
								Dz.eq(Db.storageIntegrations.organizationId, organizationId),
								Dz.eq(Db.storageIntegrations.active, true),
								Dz.eq(Db.storageIntegrations.status, "active"),
							),
						),
				);

				return Option.fromNullable(integration);
			}),
		);

		const getIntegrationById = Effect.fn("StorageRepo.getIntegrationById")(
			(id: Storage.StorageIntegrationId) =>
				Effect.gen(function* () {
					const [integration] = yield* db.use((db) =>
						db
							.select()
							.from(Db.storageIntegrations)
							.where(Dz.eq(Db.storageIntegrations.id, id)),
					);

					return Option.fromNullable(integration);
				}),
		);

		const getGoogleDriveConfig = Effect.fn("StorageRepo.getGoogleDriveConfig")(
			(integration: typeof Db.storageIntegrations.$inferSelect) =>
				Effect.tryPromise({
					try: async () =>
						JSON.parse(
							await decrypt(integration.encryptedConfig),
						) as GoogleDriveIntegrationConfig,
					catch: (cause) => new Storage.StorageError({ cause }),
				}),
		);

		const getGoogleDriveAccessTokenCache = Effect.fn(
			"StorageRepo.getGoogleDriveAccessTokenCache",
		)((integration: typeof Db.storageIntegrations.$inferSelect) =>
			decodeGoogleDriveAccessTokenCache({
				googleDriveAccessToken: integration.googleDriveAccessToken,
				googleDriveAccessTokenExpiresAt:
					integration.googleDriveAccessTokenExpiresAt,
			}),
		);

		const getGoogleDriveAccessTokenCacheById = Effect.fn(
			"StorageRepo.getGoogleDriveAccessTokenCacheById",
		)((id: Storage.StorageIntegrationId) =>
			Effect.gen(function* () {
				const [integration] = yield* db.use((db) =>
					db
						.select({
							googleDriveAccessToken:
								Db.storageIntegrations.googleDriveAccessToken,
							googleDriveAccessTokenExpiresAt:
								Db.storageIntegrations.googleDriveAccessTokenExpiresAt,
						})
						.from(Db.storageIntegrations)
						.where(Dz.eq(Db.storageIntegrations.id, id))
						.limit(1),
				);

				if (!integration) return Option.none<GoogleDriveAccessTokenCache>();
				return yield* decodeGoogleDriveAccessTokenCache(integration);
			}),
		);

		const claimGoogleDriveTokenRefreshLease = Effect.fn(
			"StorageRepo.claimGoogleDriveTokenRefreshLease",
		)(
			(
				id: Storage.StorageIntegrationId,
				leaseId: string,
				leaseExpiresAt: Date,
			) =>
				Effect.gen(function* () {
					const result = yield* db.use((db) =>
						db
							.update(Db.storageIntegrations)
							.set({
								googleDriveTokenRefreshLeaseId: leaseId,
								googleDriveTokenRefreshLeaseExpiresAt: leaseExpiresAt,
								updatedAt: new Date(),
							})
							.where(
								Dz.and(
									Dz.eq(Db.storageIntegrations.id, id),
									Dz.or(
										Dz.isNull(
											Db.storageIntegrations
												.googleDriveTokenRefreshLeaseExpiresAt,
										),
										Dz.lt(
											Db.storageIntegrations
												.googleDriveTokenRefreshLeaseExpiresAt,
											new Date(),
										),
									),
								),
							),
					);

					return getAffectedRows(result) > 0;
				}),
		);

		const saveGoogleDriveAccessTokenCache = Effect.fn(
			"StorageRepo.saveGoogleDriveAccessTokenCache",
		)(
			(
				id: Storage.StorageIntegrationId,
				leaseId: string,
				cache: GoogleDriveAccessTokenCache,
			) =>
				Effect.gen(function* () {
					const googleDriveAccessToken = yield* Effect.tryPromise({
						try: () => encrypt(cache.accessToken),
						catch: (cause) => new Storage.StorageError({ cause }),
					});

					const result = yield* db.use((db) =>
						db
							.update(Db.storageIntegrations)
							.set({
								googleDriveAccessToken,
								googleDriveAccessTokenExpiresAt: cache.expiresAt,
								googleDriveTokenRefreshLeaseId: null,
								googleDriveTokenRefreshLeaseExpiresAt: null,
								updatedAt: new Date(),
							})
							.where(
								Dz.and(
									Dz.eq(Db.storageIntegrations.id, id),
									Dz.eq(
										Db.storageIntegrations.googleDriveTokenRefreshLeaseId,
										leaseId,
									),
								),
							),
					);

					return getAffectedRows(result) > 0;
				}),
		);

		const releaseGoogleDriveTokenRefreshLease = Effect.fn(
			"StorageRepo.releaseGoogleDriveTokenRefreshLease",
		)((id: Storage.StorageIntegrationId, leaseId: string) =>
			db.use((db) =>
				db
					.update(Db.storageIntegrations)
					.set({
						googleDriveTokenRefreshLeaseId: null,
						googleDriveTokenRefreshLeaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(
						Dz.and(
							Dz.eq(Db.storageIntegrations.id, id),
							Dz.eq(
								Db.storageIntegrations.googleDriveTokenRefreshLeaseId,
								leaseId,
							),
						),
					),
			),
		);

		const upsertObject = Effect.fn("StorageRepo.upsertObject")(
			(input: StorageObjectInput) =>
				Effect.gen(function* () {
					const objectKeyHash = getObjectKeyHash(input.objectKey);
					const uploadSessionUrl = input.uploadSessionUrl
						? yield* Effect.tryPromise({
								try: () => encrypt(input.uploadSessionUrl as string),
								catch: (cause) => new Storage.StorageError({ cause }),
							})
						: null;

					const value = {
						id: Storage.StorageObjectId.make(nanoId()),
						integrationId: input.integrationId,
						ownerId: input.ownerId,
						videoId: input.videoId,
						objectKey: input.objectKey,
						objectKeyHash,
						providerObjectId: input.providerObjectId,
						uploadSessionUrl,
						uploadStatus: input.uploadStatus ?? "pending",
						contentType: input.contentType ?? null,
						contentLength: input.contentLength ?? null,
						metadata: input.metadata ?? null,
					};

					yield* db.use((db) =>
						db
							.insert(Db.storageObjects)
							.values(value)
							.onDuplicateKeyUpdate({
								set: {
									providerObjectId: value.providerObjectId,
									uploadSessionUrl: value.uploadSessionUrl,
									uploadStatus: value.uploadStatus,
									contentType: value.contentType,
									contentLength: value.contentLength,
									metadata: value.metadata,
									updatedAt: new Date(),
								},
							}),
					);
				}),
		);

		const reserveObject = Effect.fn("StorageRepo.reserveObject")(
			(input: StorageObjectInput) =>
				Effect.gen(function* () {
					const objectKeyHash = getObjectKeyHash(input.objectKey);
					const uploadSessionUrl = input.uploadSessionUrl
						? yield* Effect.tryPromise({
								try: () => encrypt(input.uploadSessionUrl as string),
								catch: (cause) => new Storage.StorageError({ cause }),
							})
						: null;

					yield* db.use((db) =>
						db
							.insert(Db.storageObjects)
							.values({
								id: Storage.StorageObjectId.make(nanoId()),
								integrationId: input.integrationId,
								ownerId: input.ownerId,
								videoId: input.videoId,
								objectKey: input.objectKey,
								objectKeyHash,
								providerObjectId: input.providerObjectId,
								uploadSessionUrl,
								uploadStatus: input.uploadStatus ?? "pending",
								contentType: input.contentType ?? null,
								contentLength: input.contentLength ?? null,
								metadata: input.metadata ?? null,
							})
							.onDuplicateKeyUpdate({
								set: {
									id: Dz.sql`${Db.storageObjects.id}`,
								},
							}),
					);

					const object = yield* getObjectByKey(
						input.integrationId,
						input.objectKey,
					);
					return yield* Option.match(object, {
						onNone: () =>
							Effect.fail(
								new Storage.StorageError({
									cause: new Error("Storage object reservation failed"),
								}),
							),
						onSome: Effect.succeed,
					});
				}),
		);

		const getObjectByKey = Effect.fn("StorageRepo.getObjectByKey")(
			(integrationId: Storage.StorageIntegrationId, key: string) =>
				Effect.gen(function* () {
					const [object] = yield* db.use((db) =>
						db
							.select()
							.from(Db.storageObjects)
							.where(
								Dz.and(
									Dz.eq(Db.storageObjects.integrationId, integrationId),
									Dz.eq(Db.storageObjects.objectKeyHash, getObjectKeyHash(key)),
								),
							),
					);

					return Option.fromNullable(object).pipe(
						Option.filter((object) => object.objectKey === key),
					);
				}),
		);

		const listObjectsByPrefix = Effect.fn("StorageRepo.listObjectsByPrefix")(
			(
				integrationId: Storage.StorageIntegrationId,
				prefix: string | undefined,
				maxKeys: number | undefined,
			) =>
				db.use((db) => {
					const where = prefix
						? Dz.and(
								Dz.eq(Db.storageObjects.integrationId, integrationId),
								Dz.sql`BINARY ${Db.storageObjects.objectKey} LIKE ${`${escapeLikePattern(prefix)}%`}`,
							)
						: Dz.eq(Db.storageObjects.integrationId, integrationId);

					return db
						.select()
						.from(Db.storageObjects)
						.where(where)
						.orderBy(Db.storageObjects.objectKey)
						.limit(maxKeys ?? 1000);
				}),
		);

		const markObjectComplete = Effect.fn("StorageRepo.markObjectComplete")(
			(
				integrationId: Storage.StorageIntegrationId,
				key: string,
				contentLength?: number | null,
			) =>
				db.use((db) =>
					db
						.update(Db.storageObjects)
						.set({
							uploadStatus: "complete",
							contentLength: contentLength ?? undefined,
							updatedAt: new Date(),
						})
						.where(
							Dz.and(
								Dz.eq(Db.storageObjects.integrationId, integrationId),
								Dz.eq(Db.storageObjects.objectKeyHash, getObjectKeyHash(key)),
							),
						),
				),
		);

		const deleteObjectByKey = Effect.fn("StorageRepo.deleteObjectByKey")(
			(integrationId: Storage.StorageIntegrationId, key: string) =>
				db.use((db) =>
					db
						.delete(Db.storageObjects)
						.where(
							Dz.and(
								Dz.eq(Db.storageObjects.integrationId, integrationId),
								Dz.eq(Db.storageObjects.objectKeyHash, getObjectKeyHash(key)),
							),
						),
				),
		);

		return {
			getActiveIntegrationForUser,
			getActiveIntegrationForOrganization,
			getIntegrationById,
			getGoogleDriveConfig,
			getGoogleDriveAccessTokenCache,
			getGoogleDriveAccessTokenCacheById,
			claimGoogleDriveTokenRefreshLease,
			saveGoogleDriveAccessTokenCache,
			releaseGoogleDriveTokenRefreshLease,
			upsertObject,
			reserveObject,
			getObjectByKey,
			listObjectsByPrefix,
			markObjectComplete,
			deleteObjectByKey,
		};
	}),
	dependencies: [Database.Default],
}) {}
