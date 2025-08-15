import * as Db from "@cap/database/schema";
import { CurrentUser, Folder, Policy } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database, type DatabaseError } from "../Database";
import { FoldersPolicy } from "./FoldersPolicy";
import { nanoId } from "@cap/database/helpers";

export class Folders extends Effect.Service<Folders>()("Folders", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const policy = yield* FoldersPolicy;

		const deleteFolder = (folder: {
			id: Folder.FolderId;
			parentId: Folder.FolderId | null;
			spaceId: string | null;
		}): Effect.Effect<void, DatabaseError, Database> =>
			Effect.gen(function* () {
				const children = yield* db.execute((db) =>
					db
						.select({
							id: Db.folders.id,
							parentId: Db.folders.parentId,
							spaceId: Db.folders.spaceId,
						})
						.from(Db.folders)
						.where(Dz.eq(Db.folders.parentId, folder.id)),
				);

				for (const child of children) {
					yield* deleteFolder(child);
				}

				// Folders can't be both in the root and in a space
				if (folder.spaceId) {
					const { spaceId } = folder;
					yield* db.execute((db) =>
						db
							.update(Db.spaceVideos)
							.set({ folderId: folder.parentId })
							.where(
								Dz.and(
									Dz.eq(Db.spaceVideos.folderId, folder.id),
									Dz.eq(Db.spaceVideos.spaceId, spaceId),
								),
							),
					);
				} else {
					yield* db.execute((db) =>
						db
							.update(Db.videos)
							.set({ folderId: folder.parentId })
							.where(Dz.eq(Db.videos.folderId, folder.id)),
					);
				}

				yield* db.execute((db) =>
					db.delete(Db.folders).where(Dz.eq(Db.folders.id, folder.id)),
				);
			});

		return {
			create: Effect.fn("Folders.create")(function* (data: {
				name: string;
				color: Folder.FolderColor;
				spaceId: Option.Option<string>;
				parentId: Option.Option<Folder.FolderId>;
			}) {
				const user = yield* CurrentUser;

				if (Option.isSome(data.parentId)) {
					const parentId = data.parentId.value;
					const [parentFolder] = yield* db.execute((db) =>
						db
							.select()
							.from(Db.folders)
							.where(
								Dz.and(
									Dz.eq(Db.folders.id, parentId),
									Dz.eq(Db.folders.organizationId, user.activeOrgId),
								),
							),
					);

					if (!parentFolder) return yield* new Folder.NotFoundError();
				}

				const folder = {
					id: Folder.FolderId.make(nanoId()),
					name: data.name,
					color: data.color,
					organizationId: user.activeOrgId,
					createdById: user.id,
					spaceId: data.spaceId,
					parentId: data.parentId,
				}

				yield* db.execute(db => db.insert(Db.folders).values({
					...folder,
					spaceId: Option.getOrNull(folder.spaceId),
					parentId: Option.getOrNull(folder.parentId),
				}));

				return new Folder.Folder(folder)
			}),
			/**
			 * Deletes a folder and all its subfolders. Videos inside the folders will be
			 * relocated to the root of the collection (space or My Caps) they're in
			 */
			delete: Effect.fn("Folders.delete")(function* (id: Folder.FolderId) {
				const [folder] = yield* db
					.execute((db) =>
						db.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)),
					)
					.pipe(Policy.withPolicy(policy.canEdit(id)));

				if (!folder) return yield* new Folder.NotFoundError();

				yield* deleteFolder(folder);
			}),
		};
	}),
	dependencies: [FoldersPolicy.Default],
}) { }
