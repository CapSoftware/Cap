import * as Db from "@cap/database/schema";
import { GoogleDrive, type User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";

export class GoogleDriveConfigsRepo extends Effect.Service<GoogleDriveConfigsRepo>()(
	"GoogleDriveConfigsRepo",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;

			const getById = Effect.fn("GoogleDriveConfigsRepo.getById")(
				(id: GoogleDrive.GoogleDriveConfigId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ config: Db.googleDriveConfigs })
								.from(Db.googleDriveConfigs)
								.where(Dz.eq(Db.googleDriveConfigs.id, id)),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) => GoogleDrive.decodeSync(v.config)),
						);
					}),
			);

			const getForUser = Effect.fn("GoogleDriveConfigsRepo.getForUser")(
				(userId: User.UserId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ config: Db.googleDriveConfigs })
								.from(Db.googleDriveConfigs)
								.where(Dz.eq(Db.googleDriveConfigs.ownerId, userId)),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) => GoogleDrive.decodeSync(v.config)),
						);
					}),
			);

			const upsert = Effect.fn("GoogleDriveConfigsRepo.upsert")(
				(
					userId: User.UserId,
					data: {
						id: GoogleDrive.GoogleDriveConfigId;
						accessToken: string;
						refreshToken: string;
						expiresAt: number;
						email?: string | null;
						folderId?: string | null;
						folderName?: string | null;
					},
				) =>
					Effect.gen(function* () {
						yield* db.use((db) =>
							db
								.insert(Db.googleDriveConfigs)
								.values({
									id: data.id,
									ownerId: userId,
									accessToken: data.accessToken,
									refreshToken: data.refreshToken,
									expiresAt: data.expiresAt,
									email: data.email ?? null,
									folderId: data.folderId ?? null,
									folderName: data.folderName ?? null,
								})
								.onDuplicateKeyUpdate({
									set: {
										accessToken: data.accessToken,
										refreshToken: data.refreshToken,
										expiresAt: data.expiresAt,
										email: data.email ?? null,
										folderId: data.folderId ?? null,
										folderName: data.folderName ?? null,
									},
								}),
						);
					}),
			);

			const updateTokens = Effect.fn("GoogleDriveConfigsRepo.updateTokens")(
				(
					id: GoogleDrive.GoogleDriveConfigId,
					accessToken: string,
					expiresAt: number,
				) =>
					Effect.gen(function* () {
						yield* db.use((db) =>
							db
								.update(Db.googleDriveConfigs)
								.set({ accessToken, expiresAt })
								.where(Dz.eq(Db.googleDriveConfigs.id, id)),
						);
					}),
			);

			const updateFolder = Effect.fn("GoogleDriveConfigsRepo.updateFolder")(
				(
					id: GoogleDrive.GoogleDriveConfigId,
					folderId: string | null,
					folderName: string | null,
				) =>
					Effect.gen(function* () {
						yield* db.use((db) =>
							db
								.update(Db.googleDriveConfigs)
								.set({ folderId, folderName })
								.where(Dz.eq(Db.googleDriveConfigs.id, id)),
						);
					}),
			);

			const deleteForUser = Effect.fn("GoogleDriveConfigsRepo.deleteForUser")(
				(userId: User.UserId) =>
					Effect.gen(function* () {
						yield* db.use((db) =>
							db
								.delete(Db.googleDriveConfigs)
								.where(Dz.eq(Db.googleDriveConfigs.ownerId, userId)),
						);
					}),
			);

			return {
				getById,
				getForUser,
				upsert,
				updateTokens,
				updateFolder,
				deleteForUser,
			};
		}),
		dependencies: [Database.Default],
	},
) {}
