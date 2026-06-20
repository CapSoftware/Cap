import * as Db from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import {
	CurrentUser,
	type DatabaseError,
	Folder,
	Organisation,
	Policy,
	type Space,
	User,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { FoldersPolicy } from "./FoldersPolicy.ts";
import { FoldersRepo } from "./FoldersRepo.ts";

// @effect-diagnostics-next-line leakingRequirements:off
export class Folders extends Effect.Service<Folders>()("Folders", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const policy = yield* FoldersPolicy;
		const repo = yield* FoldersRepo;

		/**
		 * Making a collection public is a Pro feature, gated on the organization
		 * OWNER's plan (any manager can publish while the owner is Pro). Disabling
		 * public never requires Pro, so a downgraded org can always un-publish.
		 */
		const requireOwnerPro = (organizationId: Organisation.OrganisationId) =>
			Effect.gen(function* () {
				const [owner] = yield* db.use((db) =>
					db
						.select({
							stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
							thirdPartyStripeSubscriptionId:
								Db.users.thirdPartyStripeSubscriptionId,
						})
						.from(Db.organizations)
						.innerJoin(Db.users, Dz.eq(Db.organizations.ownerId, Db.users.id))
						.where(Dz.eq(Db.organizations.id, organizationId))
						.limit(1),
				);

				if (!userIsPro(owner ?? null))
					return yield* new Policy.PolicyDeniedError({
						reason: "Upgrade to Cap Pro to create a public collection link",
					});
			});

		const deleteFolder = (folder: {
			id: Folder.FolderId;
			parentId: Folder.FolderId | null;
			spaceId: Space.SpaceIdOrOrganisationId | null;
		}): Effect.Effect<void, DatabaseError, Database> =>
			Effect.gen(function* () {
				const children = yield* db.use((db) =>
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
					yield* db.use((db) =>
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
					yield* db.use((db) =>
						db
							.update(Db.videos)
							.set({ folderId: folder.parentId })
							.where(Dz.eq(Db.videos.folderId, folder.id)),
					);
				}

				yield* db.use((db) =>
					db.delete(Db.folders).where(Dz.eq(Db.folders.id, folder.id)),
				);
			});

		return {
			create: Effect.fn("Folders.create")(function* (data: {
				name: string;
				color: Folder.FolderColor;
				public?: boolean;
				spaceId: Option.Option<Space.SpaceIdOrOrganisationId>;
				parentId: Option.Option<Folder.FolderId>;
			}) {
				const user = yield* CurrentUser;

				if (data.public === true)
					yield* requireOwnerPro(
						Organisation.OrganisationId.make(user.activeOrganizationId),
					);

				if (Option.isSome(data.spaceId)) {
					yield* policy.canCreateIn(data.spaceId.value);
				}

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
					public: data.public ?? false,
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
					.use((db) =>
						db.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)),
					)
					.pipe(Policy.withPolicy(policy.canEdit(id)));

				if (!folder) return yield* new Folder.NotFoundError();

				yield* deleteFolder(folder);
			}),

			update: Effect.fn("Folders.update")(function* (
				data: Folder.FolderUpdate,
			) {
				const folder = yield* (yield* repo
					.getById(data.id)
					.pipe(Policy.withPolicy(policy.canEdit(data.id)))).pipe(
					Effect.catchTag(
						"NoSuchElementException",
						() => new Folder.NotFoundError(),
					),
				);

				// Drizzle throws on an all-undefined .set(); a payload with only an
				// id is a no-op, not an error.
				if (
					data.name === undefined &&
					data.color === undefined &&
					data.public === undefined &&
					data.publicPage === undefined &&
					data.parentId === undefined
				)
					return;

				// Publishing, or customizing the public page, is Pro-gated on the
				// org owner. Un-publishing (public: false) is always allowed.
				if (data.public === true || data.publicPage !== undefined)
					yield* requireOwnerPro(
						Organisation.OrganisationId.make(folder.organizationId),
					);

				// If parentId is provided and not null, verify it exists and belongs to the same organization
				if (data.parentId && Option.isSome(data.parentId)) {
					const parentId = data.parentId.value;
					// Check that we're not creating an immediate circular reference
					if (parentId === data.id)
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
						if (currentParentId === data.id)
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
				}

				yield* db.use((db) =>
					db
						.update(Db.folders)
						.set({
							name: data.name,
							color: data.color,
							public: data.public,
							// Atomic merge so concurrent patches (and the logo upload
							// action, which also writes settings.publicPage) can't
							// overwrite each other's keys.
							settings:
								data.publicPage !== undefined
									? Dz.sql`JSON_MERGE_PATCH(COALESCE(${Db.folders.settings}, '{}'), CAST(${JSON.stringify(
											{ publicPage: data.publicPage },
										)} AS JSON))`
									: undefined,
							parentId: data.parentId
								? Option.getOrNull(data.parentId)
								: undefined,
						})
						.where(Dz.eq(Db.folders.id, data.id)),
				);
			}),
		};
	}),
	dependencies: [FoldersPolicy.Default, FoldersRepo.Default, Database.Default],
}) {}
