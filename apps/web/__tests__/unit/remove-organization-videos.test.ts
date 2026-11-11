import { Organisation, Video } from "@cap/web-domain";
import { getTableName, type SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	select: vi.fn(),
	delete: vi.fn(),
	update: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: () => mocks }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { removeVideosFromOrganization } from "@/actions/organizations/remove-videos";

const dialect = new MySqlDialect();
const organizationId = Organisation.OrganisationId.make("org-1");
const ownVideo = Video.VideoId.make("video-own");
const colleagueVideo = Video.VideoId.make("video-colleague");

let memberRole: string | null;
let sharedRows: { videoId: Video.VideoId; ownerId: string }[];
const folderRows = [
	{ id: "personal-folder", organizationId, spaceId: null },
	{ id: "org-folder", organizationId, spaceId: organizationId },
	{ id: "space-folder", organizationId, spaceId: "space-1" },
	{ id: "other-org-folder", organizationId: "org-2", spaceId: "org-2" },
];
const writes: { table: string; params: unknown[] }[] = [];

// Applies a compiled `and` of `column = ?` / `column is null` comparisons on
// `folders` to a row, so the test checks the filter the action really builds.
function matchesFolderFilter(
	row: Record<string, unknown>,
	sql: string,
	params: unknown[],
) {
	if (/ or |not /i.test(sql)) throw new Error(`unsupported filter: ${sql}`);
	const comparisons = [
		...sql.matchAll(/`folders`\.`(\w+)` (= \?|is null)/g),
	];
	if (comparisons.length === 0) throw new Error(`unsupported filter: ${sql}`);
	let next = 0;
	return comparisons.every(([, column, op]) =>
		op === "is null" ? row[column] == null : row[column] === params[next++],
	);
}

beforeEach(() => {
	writes.length = 0;
	memberRole = "member";
	sharedRows = [
		{ videoId: ownVideo, ownerId: "member-user" },
		{ videoId: colleagueVideo, ownerId: "colleague" },
	];
	mocks.user.mockResolvedValue({ id: "member-user" });
	mocks.select.mockImplementation(() => {
		let table = "";
		let params: unknown[] = [];
		let sql = "";
		const rows = () => {
			if (table === "organizations")
				return [{ id: organizationId, ownerId: "org-owner" }];
			if (table === "organization_members")
				return memberRole ? [{ id: "membership", role: memberRole }] : [];
			if (table === "shared_videos")
				return sharedRows.filter((row) => params.includes(row.videoId));
			if (table === "folders")
				return folderRows
					.filter((row) => matchesFolderFilter(row, sql, params))
					.map(({ id }) => ({ id }));
			return [];
		};
		const query = Object.assign(
			Promise.resolve().then(() => rows()),
			{
				from(value: MySqlTable) {
					table = getTableName(value);
					return query;
				},
				leftJoin: () => query,
				where(filter: SQL) {
					const compiled = dialect.sqlToQuery(filter);
					params = compiled.params;
					sql = compiled.sql;
					return query;
				},
				limit: () => query,
			},
		);
		return query;
	});
	mocks.delete.mockImplementation((table: MySqlTable) => ({
		where: async (filter: SQL) => {
			writes.push({
				table: getTableName(table),
				params: dialect.sqlToQuery(filter).params,
			});
		},
	}));
	mocks.update.mockImplementation((table: MySqlTable) => ({
		set: () => ({
			where: async (filter: SQL) => {
				writes.push({
					table: getTableName(table),
					params: dialect.sqlToQuery(filter).params,
				});
			},
		}),
	}));
});

describe("removing videos from an organization", () => {
	it("leaves a colleague's shared video in place for a plain member", async () => {
		const result = await removeVideosFromOrganization(organizationId, [
			colleagueVideo,
		]);

		expect(result).toEqual({
			success: true,
			message: "No matching shared videos found in organization",
		});
		expect(writes).toEqual([]);
	});

	it("only unfiles videos from the organization's folders, not personal ones", async () => {
		await removeVideosFromOrganization(organizationId, [ownVideo]);

		expect(writes).toContainEqual({
			table: "videos",
			params: [ownVideo, "org-folder"],
		});
	});

	it("only removes and unfiles the member's own videos from a mixed request", async () => {
		const result = await removeVideosFromOrganization(organizationId, [
			ownVideo,
			colleagueVideo,
		]);

		expect(result).toMatchObject({ success: true });
		expect(writes).toEqual([
			{ table: "shared_videos", params: [organizationId, ownVideo] },
			{ table: "videos", params: [ownVideo, "org-folder"] },
		]);
	});

	it.each([
		["organization owner", "org-owner", null],
		["organization admin", "admin-user", "admin"],
	])("lets an %s remove any shared video", async (_, userId, role) => {
		mocks.user.mockResolvedValue({ id: userId });
		memberRole = role;

		const result = await removeVideosFromOrganization(organizationId, [
			colleagueVideo,
		]);

		expect(result).toMatchObject({ success: true });
		expect(writes).toEqual([
			{ table: "shared_videos", params: [organizationId, colleagueVideo] },
			{ table: "videos", params: [colleagueVideo, "org-folder"] },
		]);
	});

	it("keeps the response for videos that are not shared", async () => {
		sharedRows = [];

		await expect(
			removeVideosFromOrganization(organizationId, [ownVideo]),
		).resolves.toEqual({
			success: true,
			message: "No matching shared videos found in organization",
		});
		expect(writes).toEqual([]);
	});

	it("rejects callers outside the organization", async () => {
		memberRole = null;

		await expect(
			removeVideosFromOrganization(organizationId, [ownVideo]),
		).resolves.toMatchObject({ success: false });
		expect(writes).toEqual([]);
	});
});
