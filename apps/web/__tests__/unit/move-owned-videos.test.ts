import { Folder, Organisation, Space, Video } from "@cap/web-domain";
import { getTableName, type SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	organization: vi.fn(),
	space: vi.fn(),
	select: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	transaction: vi.fn(),
	revalidate: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: () => mocks }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationAccess: mocks.organization,
	requireOrganizationSettingsManager: vi.fn(),
}));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.space,
	requireSpaceManager: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

import {
	getOwnedVideoMoveDestinations,
	placeOwnedVideos,
} from "@/actions/folders/move-items";

const dialect = new MySqlDialect();
const filters: { table: string; sql: string; params: unknown[] }[] = [];
const locks: string[] = [];
let results: unknown[][];
const writes: { table: string; values: unknown; filter?: SQL }[] = [];
const ids: [Video.VideoId, Video.VideoId] = [
	Video.VideoId.make("video-1"),
	Video.VideoId.make("video-2"),
];
const folderId = Folder.FolderId.make("folder-1");
const spaceId = Space.SpaceId.make("space-1");

beforeEach(() => {
	results = [];
	filters.length = 0;
	locks.length = 0;
	writes.length = 0;
	mocks.user.mockResolvedValue({ id: "owner", activeOrganizationId: "org" });
	mocks.organization.mockResolvedValue({ role: "member" });
	mocks.space.mockResolvedValue({
		organizationId: "org",
		organizationRole: "member",
		spaceRole: "member",
		canManage: false,
	});
	mocks.transaction.mockImplementation(
		async (callback: (tx: typeof mocks) => Promise<unknown>) => callback(mocks),
	);
	mocks.select.mockImplementation(() => {
		let table: string;
		const query = Object.assign(Promise.resolve(results.shift() ?? []), {
			from(value: MySqlTable) {
				table = getTableName(value);
				return query;
			},
			leftJoin() {
				return query;
			},
			where(condition: SQL) {
				filters.push({ table, ...dialect.sqlToQuery(condition) });
				return query;
			},
			orderBy() {
				return query;
			},
			limit() {
				return query;
			},
			for(lock: string) {
				locks.push(lock);
				return query;
			},
		});
		return query;
	});
	mocks.insert.mockImplementation((table: MySqlTable) => ({
		values: async (values: unknown) => {
			writes.push({ table: getTableName(table), values });
		},
	}));
	mocks.update.mockImplementation((table: MySqlTable) => ({
		set: (values: unknown) => ({
			where: async (filter: SQL) => {
				writes.push({ table: getTableName(table), values, filter });
			},
		}),
	}));
});

describe("placing owned Caps in team folders", () => {
	it("adds missing team shares, moves existing shares, and preserves personal placement", async () => {
		results = [
			ids.map((id) => ({ id })),
			[{ id: folderId }],
			[{ videoId: ids[0] }],
		];
		await expect(
			placeOwnedVideos({
				videoIds: ids,
				folderId,
				location: { type: "organization" },
			}),
		).resolves.toEqual({ moved: 2 });
		expect(locks).toEqual(["update", "update"]);
		expect(filters[0]?.sql).toContain("`videos`.`ownerId` = ?");
		expect(filters[0]?.sql).toContain("`videos`.`orgId` = ?");
		expect(filters[0]?.params).toEqual([...ids, "owner", "org"]);
		expect(filters[1]?.params).toEqual([folderId, "org", "org"]);
		expect(writes).toHaveLength(2);
		expect(writes[0]).toMatchObject({
			table: "shared_videos",
			values: [
				{
					videoId: ids[1],
					folderId,
					organizationId: "org",
					sharedByUserId: "owner",
				},
			],
		});
		expect(writes[1]).toMatchObject({
			table: "shared_videos",
			values: { folderId },
		});
		expect(dialect.sqlToQuery(writes[1]?.filter as SQL).params).toEqual([
			...ids,
			"org",
		]);
		expect(mocks.revalidate).toHaveBeenCalledWith("/s/[videoId]", "page");
	});

	it("lets space members place their own Caps without changing other shares", async () => {
		results = [
			[{ createdById: "creator", memberRole: "member" }],
			[{ id: ids[0] }],
			[{ id: folderId }],
			[],
		];
		await placeOwnedVideos({
			videoIds: [ids[0]],
			folderId,
			location: { type: "space", spaceId },
		});
		expect(filters[0]).toMatchObject({
			table: "spaces",
			params: [spaceId, "org"],
		});
		expect(locks).toEqual(["update", "update", "update"]);
		expect(filters[2]?.params).toEqual([folderId, "org", spaceId]);
		expect(writes.map((write) => write.table)).toEqual([
			"space_videos",
			"space_videos",
		]);
		expect(writes[0]?.values).toEqual([
			expect.objectContaining({ videoId: ids[0], spaceId, folderId }),
		]);
	});

	it.each([
		{ name: "the space was deleted", rows: [] },
		{
			name: "space membership was revoked",
			rows: [{ createdById: "creator", memberRole: null }],
		},
	])(
		"rechecks space access inside the transaction when $name",
		async ({ rows }) => {
			results = [rows];
			await expect(
				placeOwnedVideos({
					videoIds: [ids[0]],
					folderId,
					location: { type: "space", spaceId },
				}),
			).rejects.toThrow("Space not found");
			expect(mocks.transaction).toHaveBeenCalledOnce();
			expect(filters).toHaveLength(1);
			expect(writes).toEqual([]);
		},
	);

	it.each([
		{ role: "admin", createdById: "creator" },
		{ role: "member", createdById: "owner" },
	])(
		"keeps space access for a $role organization role when the space allows it",
		async ({ role, createdById }) => {
			mocks.organization.mockResolvedValue({ role });
			mocks.space.mockResolvedValue({
				organizationId: "org",
				organizationRole: role,
				spaceRole: createdById === "owner" ? "admin" : null,
				canManage: true,
			});
			results = [[{ createdById, memberRole: null }], [{ id: ids[0] }], []];
			await expect(
				placeOwnedVideos({
					videoIds: [ids[0]],
					folderId: null,
					location: { type: "space", spaceId },
				}),
			).resolves.toEqual({ moved: 1 });
			expect(writes.map((write) => write.table)).toEqual([
				"space_videos",
				"space_videos",
			]);
		},
	);

	it("does not duplicate an existing placement on retry", async () => {
		results = [[{ id: ids[0] }], [{ videoId: ids[0] }]];
		await placeOwnedVideos({
			videoIds: [ids[0]],
			folderId: null,
			location: { type: "organization" },
		});
		expect(mocks.insert).not.toHaveBeenCalled();
		expect(writes).toHaveLength(1);
	});

	it("rejects the whole selection if any Cap is not owned in the active organization", async () => {
		results = [[{ id: ids[0] }]];
		await expect(
			placeOwnedVideos({
				videoIds: ids,
				folderId,
				location: { type: "organization" },
			}),
		).rejects.toThrow("cannot be moved");
		expect(writes).toEqual([]);
	});

	it("rejects a folder outside the selected destination", async () => {
		results = [[{ id: ids[0] }], []];
		await expect(
			placeOwnedVideos({
				videoIds: [ids[0]],
				folderId,
				location: { type: "organization" },
			}),
		).rejects.toThrow("Destination folder not found");
		expect(writes).toEqual([]);
	});

	it.each([
		null,
		{ organizationId: "other-org", organizationRole: "owner", canManage: true },
		{
			organizationId: "org",
			organizationRole: "member",
			spaceRole: null,
			canManage: false,
		},
		{
			organizationId: "org",
			organizationRole: null,
			spaceRole: "admin",
			canManage: true,
		},
	])("rejects inaccessible space %#", async (access) => {
		mocks.space.mockResolvedValue(access);
		await expect(
			placeOwnedVideos({
				videoIds: ids,
				folderId,
				location: { type: "space", spaceId },
			}),
		).rejects.toThrow("Space not found");
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("rejects former organization members before reading or writing placements", async () => {
		mocks.organization.mockRejectedValue(new Error("Forbidden"));
		await expect(
			placeOwnedVideos({
				videoIds: ids,
				folderId,
				location: { type: "organization" },
			}),
		).rejects.toThrow("Forbidden");
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("limits the selectable folders to personal and accessible team locations", async () => {
		results = [
			[{ id: spaceId, name: "Team space" }],
			[
				{ id: "mine", name: "Personal", parentId: null, spaceId: null },
				{ id: folderId, name: "Team folder", parentId: null, spaceId: "org" },
				{ id: "space-folder", name: "Space folder", parentId: null, spaceId },
			],
		];
		const destinations = await getOwnedVideoMoveDestinations();
		expect(
			destinations.map((group) => [
				group.name,
				group.folders.map((folder) => folder.id),
			]),
		).toEqual([
			["My Caps", ["mine"]],
			["All team members", [folderId]],
			["Team space", ["space-folder"]],
		]);
		expect(filters[0]?.params).toEqual(["org", "owner", "owner"]);
		expect(filters[1]?.params).toEqual(["org", "owner", "org", spaceId]);
	});

	it("scopes every check and write to a requested organization the owner belongs to", async () => {
		const organizationId = Organisation.OrganisationId.make("cap-org");
		results = [[{ id: ids[0] }], [{ id: folderId }], []];
		await placeOwnedVideos({
			videoIds: [ids[0]],
			folderId,
			location: { type: "organization" },
			organizationId,
		});
		expect(mocks.organization).toHaveBeenCalledWith("owner", organizationId);
		expect(filters[0]?.params).toEqual([ids[0], "owner", organizationId]);
		expect(filters[1]?.params).toEqual([
			folderId,
			organizationId,
			organizationId,
		]);
		expect(writes[0]?.values).toEqual([
			expect.objectContaining({ videoId: ids[0], organizationId }),
		]);
	});

	it("rejects a requested organization the owner no longer belongs to", async () => {
		mocks.organization.mockRejectedValue(new Error("Forbidden"));
		const organizationId = Organisation.OrganisationId.make("cap-org");
		await expect(getOwnedVideoMoveDestinations(organizationId)).rejects.toThrow(
			"Forbidden",
		);
		await expect(
			placeOwnedVideos({
				videoIds: [ids[0]],
				folderId: null,
				location: { type: "personal" },
				organizationId,
			}),
		).rejects.toThrow("Forbidden");
		expect(mocks.organization).toHaveBeenCalledWith("owner", organizationId);
		expect(mocks.select).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("lists destinations in a requested organization", async () => {
		const organizationId = Organisation.OrganisationId.make("cap-org");
		results = [[], []];
		await getOwnedVideoMoveDestinations(organizationId);
		expect(mocks.organization).toHaveBeenCalledWith("owner", organizationId);
		expect(filters[0]?.params).toEqual([organizationId, "owner", "owner"]);
		expect(filters[1]?.params).toEqual([
			organizationId,
			"owner",
			organizationId,
		]);
	});

	it("keeps personal moves private and checks personal folder ownership", async () => {
		results = [[{ id: ids[0] }], [{ id: folderId }]];
		await placeOwnedVideos({
			videoIds: [ids[0]],
			folderId,
			location: { type: "personal" },
		});
		expect(filters[1]?.params).toEqual([folderId, "org", "owner"]);
		expect(filters[1]?.sql).toContain("`folders`.`spaceId` is null");
		expect(writes.map((write) => write.table)).toEqual(["videos"]);
	});
});
