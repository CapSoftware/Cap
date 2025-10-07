import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	Folder,
	Organisation,
	Policy,
	User,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database, type DatabaseError } from "../Database.ts";
import { FoldersPolicy } from "./FoldersPolicy.ts";
import { FoldersRepo } from "./FoldersRepo.ts";

// @effect-diagnostics-next-line leakingRequirements:off
export class Folders extends Effect.Service<Folders>()("Folders", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const policy = yield* FoldersPolicy;
		const repo = yield* FoldersRepo;

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

					yield* repo
						.getById(parentId, {
							organizationId: Organisation.OrganisationId.make(
								user.activeOrganizationId,
							),
						})
						.pipe(
							Policy.withPolicy(policy.canEdit(parentId)),
							Effect.flatMap(
								Effect.catchTag(
									"NoSuchElementException",
									() => new Folder.NotFoundError(),
								),
							),
						);
				}

				yield* repo.create({
					name: data.name,
					color: data.color,
					organizationId: Organisation.OrganisationId.make(
						user.activeOrganizationId,
					),
					createdById: User.UserId.make(user.id),
					spaceId: data.spaceId,
					parentId: data.parentId,
				});
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

			update: Effect.fn("Folders.update")(function* (
				folderId: Folder.FolderId,
				data: Folder.FolderUpdate,
			) {
				const folder = yield* repo
					.getById(folderId)
					.pipe(
						Policy.withPolicy(policy.canEdit(folderId)),
						Effect.flatMap(
							Effect.catchTag(
								"NoSuchElementException",
								() => new Folder.NotFoundError(),
							),
						),
					);

				// If parentId is provided and not null, verify it exists and belongs to the same organization
				if (!data.parentId) return;
				const parentId = data.parentId;

				// Check that we're not creating an immediate circular reference
				if (parentId === folderId)
					return yield* new Folder.RecursiveDefinitionError();

				const parentFolder = yield* repo
					.getById(parentId, {
						organizationId: Organisation.OrganisationId.make(
							folder.organizationId,
						),
					})
					.pipe(
						Policy.withPolicy(policy.canEdit(parentId)),
						Effect.flatMap(
							Effect.catchTag(
								"NoSuchElementException",
								() => new Folder.ParentNotFoundError(),
							),
						),
					);

				// Check for circular references in the folder hierarchy
				let currentParentId = parentFolder.parentId;
				while (currentParentId) {
					if (currentParentId === folderId)
						return yield* new Folder.RecursiveDefinitionError();

					const parentId = currentParentId;
					const nextParent = yield* repo.getById(parentId, {
						organizationId: Organisation.OrganisationId.make(
							folder.organizationId,
						),
					});

					if (Option.isNone(nextParent)) break;
					currentParentId = nextParent.value.parentId;
				}

				yield* db.execute((db) =>
					db
						.update(Db.folders)
						.set({
							...(data.name ? { name: data.name } : {}),
							...(data.color ? { color: data.color } : {}),
							...(data.parentId ? { parentId: data.parentId } : {}),
						})
						.where(Dz.eq(Db.folders.id, folderId)),
				);
			}),
		};
	}),
	dependencies: [FoldersPolicy.Default, FoldersRepo.Default, Database.Default],
}) {}
