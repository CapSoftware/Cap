import type * as Db from "@cap/database/schema";
import {
	CurrentUser,
	Folder,
	Organisation,
	Policy,
	Space,
	User,
} from "@cap/web-domain";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Database } from "../../../../packages/web-backend/src/Database";
import { Folders } from "../../../../packages/web-backend/src/Folders";
import { FoldersPolicy } from "../../../../packages/web-backend/src/Folders/FoldersPolicy";
import { FoldersRepo } from "../../../../packages/web-backend/src/Folders/FoldersRepo";
import { OrganisationsPolicy } from "../../../../packages/web-backend/src/Organisations/OrganisationsPolicy";
import { Spaces } from "../../../../packages/web-backend/src/Spaces";
import { SpacesPolicy } from "../../../../packages/web-backend/src/Spaces/SpacesPolicy";

const activeOrganizationId = Organisation.OrganisationId.make("active-org");
const otherOrganizationId = Organisation.OrganisationId.make("other-org");
const userId = User.UserId.make("user-1");
const spaceId = Space.SpaceId.make("space-1");
const folderId = Folder.FolderId.make("folder-1");

function makeFixture(
	variant: "space" | "organization" | "missing",
	organizationId = activeOrganizationId,
	canManage = true,
) {
	const targetId = variant === "organization" ? organizationId : spaceId;
	const create = vi.fn(() => Effect.succeed(folderId));
	const folder: typeof Db.folders.$inferSelect = {
		id: folderId,
		name: "Existing folder",
		color: "normal",
		public: false,
		settings: null,
		organizationId,
		createdById: userId,
		spaceId: targetId,
		parentId: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const spaceOrOrg =
		variant === "missing"
			? undefined
			: variant === "organization"
				? {
						variant,
						organization: { id: organizationId, name: "Org", ownerId: userId },
					}
				: {
						variant,
						space: {
							id: spaceId,
							name: "Space",
							organizationId,
							createdById: userId,
							iconUrl: null,
							settings: null,
							public: false,
							hasPassword: false,
						},
					};
	const managerPolicy = () =>
		canManage ? Effect.void : Effect.fail(new Policy.PolicyDeniedError());
	const run = <A, E>(
		operation: Effect.Effect<A, E, Folders | FoldersPolicy | CurrentUser>,
	) =>
		Effect.runPromise(
			operation.pipe(
				Effect.provide(Folders.DefaultWithoutDependencies),
				Effect.provide(FoldersPolicy.DefaultWithoutDependencies),
				Effect.provideService(
					FoldersRepo,
					FoldersRepo.make({
						create,
						getById: () => Effect.succeed(Option.some(folder)),
						delete: () => Effect.die("Unexpected delete"),
						update: () => Effect.die("Unexpected update"),
					}),
				),
				Effect.provideService(
					Spaces,
					Spaces.make({ getSpaceOrOrg: () => Effect.succeed(spaceOrOrg) }),
				),
				Effect.provideService(
					SpacesPolicy,
					SpacesPolicy.make({
						isAdmin: managerPolicy,
						isMember: () => Effect.void,
						isOwner: managerPolicy,
					}),
				),
				Effect.provideService(
					OrganisationsPolicy,
					OrganisationsPolicy.make({
						isAdminOrOwner: managerPolicy,
						isMember: () => Effect.void,
						isOwner: managerPolicy,
					}),
				),
				Effect.provideService(
					Database,
					Database.make({
						use: () => Effect.die("Unexpected database access"),
					}),
				),
				Effect.provideService(CurrentUser, {
					id: userId,
					email: "user@example.com",
					activeOrganizationId,
					iconUrlOrKey: Option.none(),
				}),
			),
		);
	const createFolder = (personal = false) =>
		run(
			Effect.flatMap(Folders, (folders) =>
				folders.create({
					name: "New folder",
					color: "blue",
					spaceId: personal ? Option.none() : Option.some(targetId),
					parentId: Option.none(),
				}),
			).pipe(Effect.either),
		);
	return { create, createFolder, run };
}

describe.each(["space", "organization"] as const)(
	"folder creation in a %s",
	(variant) => {
		it("rejects a destination from another organization before inserting", async () => {
			const fixture = makeFixture(variant, otherOrganizationId);
			expect(await fixture.createFolder()).toMatchObject({
				_tag: "Left",
				left: { _tag: "PolicyDenied" },
			});
			expect(fixture.create).not.toHaveBeenCalled();
		});

		it("allows managers to create folders in the active organization", async () => {
			const fixture = makeFixture(variant);
			expect(await fixture.createFolder()).toMatchObject({
				_tag: "Right",
				right: undefined,
			});
			expect(fixture.create).toHaveBeenCalledWith(
				expect.objectContaining({ organizationId: activeOrganizationId }),
			);
		});

		it("still rejects ordinary members of the active organization", async () => {
			const fixture = makeFixture(variant, activeOrganizationId, false);
			expect(await fixture.createFolder()).toMatchObject({
				_tag: "Left",
				left: { _tag: "PolicyDenied" },
			});
			expect(fixture.create).not.toHaveBeenCalled();
		});

		it("allows managers to edit existing folders outside the active organization", async () => {
			const fixture = makeFixture(variant, otherOrganizationId);
			await expect(
				fixture.run(
					Effect.flatMap(FoldersPolicy, (policy) => policy.canEdit(folderId)),
				),
			).resolves.toBeUndefined();
		});
	},
);

it("rejects a destination that no longer exists", async () => {
	const fixture = makeFixture("missing");
	expect(await fixture.createFolder()).toMatchObject({
		_tag: "Left",
		left: { _tag: "PolicyDenied" },
	});
	expect(fixture.create).not.toHaveBeenCalled();
});

it("allows personal folder creation without a space", async () => {
	const fixture = makeFixture("missing");
	expect(await fixture.createFolder(true)).toMatchObject({
		_tag: "Right",
		right: undefined,
	});
	expect(fixture.create).toHaveBeenCalledOnce();
});
