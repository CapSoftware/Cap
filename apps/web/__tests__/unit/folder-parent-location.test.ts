import type * as Db from "@cap/database/schema";
import {
	CurrentUser,
	Folder,
	Organisation,
	Space,
	User,
} from "@cap/web-domain";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Database } from "../../../../packages/web-backend/src/Database";
import { Folders } from "../../../../packages/web-backend/src/Folders";
import { FoldersPolicy } from "../../../../packages/web-backend/src/Folders/FoldersPolicy";
import { FoldersRepo } from "../../../../packages/web-backend/src/Folders/FoldersRepo";

const organizationId = Organisation.OrganisationId.make("org-1");
const userId = User.UserId.make("user-1");
const parentId = Folder.FolderId.make("parent");
const childId = Folder.FolderId.make("child");
const parentSpaceId = Space.SpaceId.make("space-a");
const childSpaceId = Space.SpaceId.make("space-b");

const parent: typeof Db.folders.$inferSelect = {
	id: parentId,
	name: "Parent",
	color: "normal",
	public: false,
	settings: null,
	organizationId,
	createdById: userId,
	spaceId: parentSpaceId,
	parentId: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

function makeFixture() {
	const create = vi.fn(() => Effect.succeed(childId));
	const repo = FoldersRepo.make({
		getById: (id) =>
			Effect.succeed(
				Option.some(
					id === parentId
						? parent
						: { ...parent, id: childId, spaceId: childSpaceId },
				),
			),
		create,
		delete: () => Effect.die("Unexpected folder delete"),
		update: () => Effect.succeed(Option.none()),
	});
	const policy = FoldersPolicy.make({
		canCreateIn: () => Effect.void,
		canEdit: () => Effect.void,
	});
	const database = Database.make({
		use: () => Effect.die("Unexpected database write"),
	});
	const run = <A, E>(
		operation: (folders: Folders) => Effect.Effect<A, E, CurrentUser>,
	) =>
		Effect.runPromise(
			Effect.flatMap(Folders, operation).pipe(
				Effect.provide(Folders.DefaultWithoutDependencies),
				Effect.provideService(FoldersRepo, repo),
				Effect.provideService(FoldersPolicy, policy),
				Effect.provideService(Database, database),
				Effect.provideService(CurrentUser, {
					id: userId,
					email: "user@example.com",
					activeOrganizationId: organizationId,
					iconUrlOrKey: Option.none(),
				}),
			),
		);
	return { create, run };
}

describe("folder parent location", () => {
	it("rejects a new child in a different space", async () => {
		const fixture = makeFixture();
		const result = await fixture.run((folders) =>
			Effect.either(
				folders.create({
					name: "Child",
					color: "normal",
					spaceId: Option.some(childSpaceId),
					parentId: Option.some(parentId),
				}),
			),
		);

		expect(result).toMatchObject({
			_tag: "Left",
			left: { _tag: "FolderNotFoundError" },
		});
		expect(fixture.create).not.toHaveBeenCalled();
	});

	it("allows a new child in its parent's space", async () => {
		const fixture = makeFixture();
		const result = await fixture.run((folders) =>
			folders.create({
				name: "Child",
				color: "normal",
				spaceId: Option.some(parentSpaceId),
				parentId: Option.some(parentId),
			}),
		);

		expect(result).toBeUndefined();
		expect(fixture.create).toHaveBeenCalledOnce();
	});

	it("rejects moving a child under a parent in a different space", async () => {
		const fixture = makeFixture();
		const result = await fixture.run((folders) =>
			Effect.either(
				folders.update({ id: childId, parentId: Option.some(parentId) }),
			),
		);

		expect(result).toMatchObject({
			_tag: "Left",
			left: { _tag: "ParentNotFoundError" },
		});
	});
});
