import {
	sharedVideos,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import { Space, Video } from "@cap/web-domain";
import { getTableColumns } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), user: vi.fn() }));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.user,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { shareCap } from "@/actions/caps/share";

const capId = Video.VideoId.make("video-1");
const spaceId = Space.SpaceId.make("space-1");
let privacy: "Private" | "Public";
let creatorId: string;
let organizationRole: string | null;
let spaceRole: string | null;
let videoOwnerId: string;
let accessExists: boolean;
let accessError: boolean;
let alreadyShared: boolean;
let organizationShareExists: boolean;

function row(table: MySqlTable, values: Record<string, unknown>) {
	return Object.values(getTableColumns(table)).map(
		(column) => values[column.name] ?? null,
	);
}

beforeEach(() => {
	privacy = "Private";
	creatorId = "space-owner";
	organizationRole = "member";
	spaceRole = null;
	videoOwnerId = "caller";
	accessExists = true;
	accessError = false;
	alreadyShared = false;
	organizationShareExists = false;
	mocks.user.mockResolvedValue({ id: "caller" });
	mocks.query.mockImplementation(async (query: string) => {
		if (query.startsWith("delete from `shared_videos`")) {
			organizationShareExists = false;
		}
		if (/^(insert|update|delete) /.test(query)) {
			return { rows: [{ insertId: 0, affectedRows: 1 }] };
		}
		if (query.includes("where (false")) return { rows: [] };
		if (query.includes("from `videos`")) {
			return { rows: [row(videos, { id: capId, ownerId: videoOwnerId })] };
		}
		if (query.includes("from `space_videos`") && alreadyShared) {
			return {
				rows: [row(spaceVideos, { id: "share-1", videoId: capId, spaceId })],
			};
		}
		if (query.includes("from `shared_videos`") && organizationShareExists) {
			return {
				rows: [
					row(sharedVideos, {
						id: "organization-share-1",
						videoId: capId,
						organizationId: "org-1",
					}),
				],
			};
		}
		if (query.includes("from `organization_members`")) {
			return { rows: [["org-1"]] };
		}
		if (query.includes("from `spaces`")) {
			if (query.includes("inner join `organizations`")) {
				if (accessError) throw new Error("Database unavailable");
				if (!accessExists) return { rows: [] };
				return {
					rows: [
						[
							spaceId,
							"org-1",
							creatorId,
							"org-owner",
							organizationRole,
							spaceRole,
						],
					],
				};
			}
			return {
				rows: [
					row(spaces, {
						id: spaceId,
						organizationId: "org-1",
						createdById: creatorId,
						privacy,
					}),
				],
			};
		}
		return { rows: [] };
	});
});

const writes = () =>
	mocks.query.mock.calls.filter(([query]) =>
		/^(insert|update|delete) /.test(query),
	);

describe("sharing Caps to private spaces", () => {
	it("rejects an organization member outside the space before changing any shares or visibility", async () => {
		organizationShareExists = true;
		await expect(
			shareCap({ capId, spaceIds: [spaceId], public: true }),
		).resolves.toMatchObject({ success: false });
		expect(organizationShareExists).toBe(true);
		expect(writes()).toEqual([]);
		const accessQuery = mocks.query.mock.calls.find(([query]) =>
			query.includes("inner join `organizations`"),
		);
		expect(accessQuery?.[0]).toContain("`organization_members`.`userId` = ?");
		expect(accessQuery?.[0]).toContain("`space_members`.`userId` = ?");
		expect(accessQuery?.[0]).toContain("`spaces`.`id` = ?");
		expect(accessQuery?.[0]).toContain("`organizations`.`tombstoneAt` is null");
		expect(accessQuery?.[1]).toEqual(["caller", "caller", spaceId, 1]);
	});

	it("rejects a missing space access row without writing", async () => {
		accessExists = false;
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(writes()).toEqual([]);
	});

	it("does not write when the space access query fails", async () => {
		accessError = true;
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			shareCap({ capId, spaceIds: [spaceId] }),
		).resolves.toMatchObject({
			success: false,
		});
		expect(writes()).toEqual([]);
	});

	it.each(["member", "admin"])("allows a space %s", async (role) => {
		spaceRole = role;
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: true,
		});
		expect(writes()).toHaveLength(1);
		expect(writes()[0]?.[0]).toMatch(/^insert into `space_videos`/);
		expect(writes()[0]?.[1]).toEqual(
			expect.arrayContaining([capId, spaceId, "caller"]),
		);
	});

	it("allows the space creator without a space membership row", async () => {
		creatorId = "caller";
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: true,
		});
		expect(writes()).toHaveLength(1);
	});

	it("allows an organization admin without a space membership row", async () => {
		organizationRole = "admin";
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: true,
		});
		expect(writes()).toHaveLength(1);
	});

	it("preserves sharing to an organization-visible space", async () => {
		privacy = "Public";
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: true,
		});
		expect(writes()).toHaveLength(1);
	});

	it("keeps an existing private space share when access was since removed", async () => {
		alreadyShared = true;
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: true,
		});
		expect(writes()).toEqual([]);
		expect(
			mocks.query.mock.calls.some(([query]) =>
				query.includes("inner join `organizations`"),
			),
		).toBe(false);
	});

	it("rejects unauthenticated callers without querying the database", async () => {
		mocks.user.mockResolvedValue(null);
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("still rejects another user's video", async () => {
		videoOwnerId = "another-user";
		spaceRole = "admin";
		await expect(shareCap({ capId, spaceIds: [spaceId] })).resolves.toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(writes()).toEqual([]);
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it("allows clearing sharing without a destination space", async () => {
		await expect(shareCap({ capId, spaceIds: [] })).resolves.toEqual({
			success: true,
		});
		expect(writes()).toEqual([]);
	});
});
