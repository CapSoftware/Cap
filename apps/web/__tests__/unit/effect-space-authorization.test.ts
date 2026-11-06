import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	Folder,
	Organisation,
	Space,
	User,
} from "@cap/web-domain";
import { getTableColumns } from "drizzle-orm";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../../../../packages/web-backend/src/Database";
import { Folders } from "../../../../packages/web-backend/src/Folders";
import { Spaces } from "../../../../packages/web-backend/src/Spaces";

const mocks = vi.hoisted(() => ({
	query:
		vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>(),
	organizationRole: null as string | null,
	spaceRole: null as string | null,
	creatorId: "creator",
	ownerId: "owner",
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});

const organizationId = Organisation.OrganisationId.make("org-1");
const spaceId = Space.SpaceId.make("space-1");
const folderId = Folder.FolderId.make("folder-1");
const userId = User.UserId.make("creator");

function run<A, E>(
	operation: Effect.Effect<A, E, Spaces | Folders | CurrentUser | Database>,
) {
	return operation.pipe(
		Effect.provide([Spaces.Default, Folders.Default, Database.Default]),
		Effect.provideService(CurrentUser, {
			id: userId,
			email: "creator@example.com",
			activeOrganizationId: Organisation.OrganisationId.make("personal-org"),
			iconUrlOrKey: Option.none(),
		}),
		Effect.either,
		Effect.runPromise,
	);
}

beforeEach(() => {
	mocks.organizationRole = null;
	mocks.spaceRole = null;
	mocks.creatorId = userId;
	mocks.ownerId = "owner";
	mocks.query.mockImplementation(async (sql, params) => {
		if (!sql.startsWith("select"))
			return { rows: [{ insertId: 0, affectedRows: 1 }] };
		if (sql.includes("from `space_members`")) {
			return {
				rows: mocks.spaceRole ? [["space-member", mocks.spaceRole]] : [],
			};
		}
		if (sql.includes("from `organizations`")) {
			if (!sql.includes("left join") || !params.includes(organizationId))
				return { rows: [] };
			return {
				rows:
					mocks.organizationRole || mocks.ownerId === userId
						? [
								[
									mocks.organizationRole ? "org-member" : null,
									mocks.ownerId,
									mocks.organizationRole,
								],
							]
						: [],
			};
		}
		if (sql.includes("from `spaces`")) {
			const space = {
				id: spaceId,
				primary: false,
				name: "Team space",
				organizationId,
				createdById: mocks.creatorId,
				iconUrl: null,
				description: null,
				settings: null,
				password: null,
				createdAt: "2026-01-01 00:00:00",
				updatedAt: "2026-01-01 00:00:00",
				privacy: "Private",
				public: false,
			};
			return {
				rows: [
					sql.includes("IS NOT NULL")
						? [
								space.id,
								space.name,
								space.organizationId,
								space.createdById,
								null,
								null,
								false,
								false,
							]
						: Object.keys(getTableColumns(Db.spaces)).map(
								(key) => space[key as keyof typeof space],
							),
				],
			};
		}
		if (sql.includes("from `folders`") && !sql.includes("`parentId` = ?")) {
			return {
				rows: [
					[
						folderId,
						"Folder",
						"normal",
						false,
						null,
						organizationId,
						userId,
						null,
						spaceId,
						"2026-01-01 00:00:00",
						"2026-01-01 00:00:00",
					],
				],
			};
		}
		return { rows: [] };
	});
});

describe("Effect space authorization", () => {
	it.each([null, "admin"])(
		"denies a removed creator with space role %s",
		async (spaceRole) => {
			mocks.spaceRole = spaceRole;
			expect(
				await run(
					Effect.flatMap(Spaces, (spaces) => spaces.getSpaceOrOrg(spaceId)),
				),
			).toMatchObject({
				_tag: "Left",
				left: { _tag: "PolicyDenied" },
			});
		},
	);

	it("denies a stale space member outside the organization", async () => {
		mocks.creatorId = "other";
		mocks.spaceRole = "member";
		expect(
			await run(
				Effect.flatMap(Spaces, (spaces) => spaces.getSpaceOrOrg(spaceId)),
			),
		).toMatchObject({
			_tag: "Left",
			left: { _tag: "PolicyDenied" },
		});
	});

	it.each(["create", "update", "delete"] as const)(
		"blocks a removed creator's folder %s before writing",
		async (operation) => {
			const result = await run(
				Effect.flatMap(Folders, (folders) => {
					switch (operation) {
						case "create":
							return folders.create({
								name: "New",
								color: "normal",
								spaceId: Option.some(spaceId),
								parentId: Option.none(),
							});
						case "update":
							return folders.update({ id: folderId, name: "Changed" });
						case "delete":
							return folders.delete(folderId);
					}
				}),
			);
			expect(result).toMatchObject({
				_tag: "Left",
				left: { _tag: "PolicyDenied" },
			});
			expect(
				mocks.query.mock.calls.every(([sql]) => sql.startsWith("select")),
			).toBe(true);
		},
	);

	it.each(["creator", "member", "admin", "owner"])(
		"keeps access for a current organization %s",
		async (role) => {
			mocks.organizationRole =
				role === "owner" ? null : role === "admin" ? "admin" : "member";
			mocks.creatorId = role === "creator" ? userId : "other";
			mocks.spaceRole = role === "member" ? "member" : null;
			mocks.ownerId = role === "owner" ? userId : "owner";
			expect(
				await run(
					Effect.flatMap(Spaces, (spaces) => spaces.getSpaceOrOrg(spaceId)),
				),
			).toMatchObject({
				_tag: "Right",
				right: { variant: "space", space: { id: spaceId } },
			});
		},
	);

	it("still denies a current member outside the private space", async () => {
		mocks.organizationRole = "member";
		mocks.creatorId = "other";
		expect(
			await run(
				Effect.flatMap(Spaces, (spaces) => spaces.getSpaceOrOrg(spaceId)),
			),
		).toMatchObject({
			_tag: "Left",
			left: { _tag: "PolicyDenied" },
		});
	});
});
