import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { Folder, type Organisation, type User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Schema } from "effect/Schema";
import { Database } from "../Database.ts";

export type CreateFolderInput = Omit<
	Schema.Type<typeof Folder.Folder>,
	"id" | "createdAt" | "updatedAt"
> & {
	organizationId: Organisation.OrganisationId;
	createdById: User.UserId;
};

export class FoldersRepo extends Effect.Service<FoldersRepo>()("FoldersRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		/**
		 * Gets a `Folder` by its ID.
		 */
		const getById = (id: Folder.FolderId) =>
			Effect.gen(function* () {
				const [folder] = yield* db.execute((db) =>
					db.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)),
				);

				return Option.fromNullable(folder);
			});

		const delete_ = (id: Folder.FolderId) =>
			db.execute((db) => db.delete(Db.folders).where(Dz.eq(Db.folders.id, id)));

		const create = (data: CreateFolderInput) =>
			Effect.gen(function* () {
				const id = Folder.FolderId.make(nanoId());

				yield* db.execute((db) =>
					db.insert(Db.folders).values([
						{
							...data,
							id,
							parentId: Option.getOrNull(data.parentId ?? Option.none()),
							spaceId: Option.getOrNull(data.spaceId ?? Option.none()),
						},
					]),
				);

				return id;
			});

		const update = (id: Folder.FolderId, data: Partial<CreateFolderInput>) =>
			Effect.gen(function* () {
				yield* db.execute((db) =>
					db
						.update(Db.folders)
						.set({
							...data,
							parentId: data.parentId
								? Option.getOrNull(data.parentId)
								: undefined,
							spaceId: data.spaceId
								? Option.getOrNull(data.spaceId)
								: undefined,
							updatedAt: new Date(),
						})
						.where(Dz.eq(Db.folders.id, id)),
				);

				return yield* getById(id);
			});

		return { getById, delete: delete_, create, update };
	}),
	dependencies: [Database.Default],
}) {}
