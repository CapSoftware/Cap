import { Folder, Organisation, Space, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addVideosToFolder } from "@/actions/folders/add-videos";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	user: vi.fn(),
	organizationAccess: vi.fn(),
	spaceAccess: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.spaceAccess,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const folderId = Folder.FolderId.make("folder-1");
const orgId = Organisation.OrganisationId.make("org-1");
const existingId = Video.VideoId.make("existing-video");
const newId = Video.VideoId.make("new-video");

beforeEach(() => {
	mocks.user.mockResolvedValue({ id: "owner", activeOrganizationId: orgId });
	mocks.organizationAccess.mockResolvedValue({
		id: orgId,
		ownerId: "owner",
		memberId: "member-1",
		role: "owner",
	});
	mocks.spaceAccess.mockResolvedValue({
		spaceId: "space-1",
		organizationId: orgId,
		organizationOwnerId: "owner",
		createdById: "owner",
		organizationRole: "owner",
		spaceRole: "admin",
		canManage: true,
	});
});

describe.each([
	{
		name: "space",
		spaceId: Space.SpaceId.make("space-1"),
		table: "space_videos",
	},
	{ name: "organization", spaceId: orgId, table: "shared_videos" },
])("adding videos to a $name folder", ({ spaceId, table }) => {
	function setup(
		ownedIds: Video.VideoId[],
		sharedIds: Video.VideoId[],
		folderOrganizationId: Organisation.OrganisationId = orgId,
	) {
		mocks.query.mockImplementation(async (query: string) => {
			if (query.startsWith("select")) {
				if (query.includes("from `folders`")) {
					return { rows: [[folderId, folderOrganizationId, spaceId]] };
				}
				if (query.includes("from `videos`")) {
					return { rows: ownedIds.map((id) => [id]) };
				}
				return { rows: sharedIds.map((id) => [id]) };
			}
			return { rows: [{ insertId: 1, affectedRows: 1 }] };
		});
	}

	it("moves an existing share without inserting another sharing row", async () => {
		setup([existingId], [existingId]);

		await expect(
			addVideosToFolder(folderId, [existingId], spaceId),
		).resolves.toMatchObject({ success: true, addedCount: 1 });

		const writes = mocks.query.mock.calls.filter(([query]) =>
			String(query).startsWith("insert"),
		);
		expect(writes).toHaveLength(0);
		const update = mocks.query.mock.calls.find(([query]) =>
			String(query).startsWith(`update \`${table}\``),
		);
		expect(update?.[1]).toEqual([folderId, spaceId, existingId]);
	});

	it("inserts only missing shares when moving a mixed selection", async () => {
		setup([existingId, newId], [existingId]);

		await expect(
			addVideosToFolder(folderId, [existingId, newId], spaceId),
		).resolves.toMatchObject({ success: true, addedCount: 2 });

		const insert = mocks.query.mock.calls.find(([query]) =>
			String(query).startsWith(`insert into \`${table}\``),
		);
		expect(insert?.[1]).toContain(newId);
		expect(insert?.[1]).not.toContain(existingId);
		const existingQuery = mocks.query.mock.calls.find(([query]) =>
			String(query).includes(`from \`${table}\``),
		);
		expect(existingQuery?.[1]).toEqual([spaceId, existingId, newId]);
		expect(existingQuery?.[0]).not.toContain("folderId");
		const update = mocks.query.mock.calls.find(([query]) =>
			String(query).startsWith(`update \`${table}\``),
		);
		expect(update?.[1]).toEqual([folderId, spaceId, existingId, newId]);
	});

	it("creates the share when the video is not in this collection", async () => {
		setup([newId], []);

		await expect(
			addVideosToFolder(folderId, [newId], spaceId),
		).resolves.toMatchObject({ success: true, addedCount: 1 });

		const insert = mocks.query.mock.calls.find(([query]) =>
			String(query).startsWith(`insert into \`${table}\``),
		);
		expect(insert?.[1]).toEqual([
			expect.any(String),
			...(table === "shared_videos"
				? [newId, folderId, spaceId, "owner"]
				: [spaceId, folderId, newId, "owner"]),
		]);
	});

	it("does not share requested videos the caller does not own", async () => {
		setup([newId], []);

		await expect(
			addVideosToFolder(folderId, [existingId, newId], spaceId),
		).resolves.toMatchObject({ success: true, addedCount: 1 });

		const writes = mocks.query.mock.calls.filter(
			([query]) => !String(query).startsWith("select"),
		);
		expect(writes).toHaveLength(2);
		for (const [, params] of writes) {
			expect(params).toContain(newId);
			expect(params).not.toContain(existingId);
		}
	});

	it("rejects a caller without access to the collection", async () => {
		setup([newId], []);
		mocks.organizationAccess.mockResolvedValue(null);
		mocks.spaceAccess.mockResolvedValue(null);

		await expect(
			addVideosToFolder(folderId, [newId], spaceId),
		).resolves.toMatchObject({ success: false });

		expect(
			mocks.query.mock.calls.every(([query]) =>
				String(query).startsWith("select"),
			),
		).toBe(true);
	});

	it("rejects a folder that belongs to another organization", async () => {
		setup([newId], [], Organisation.OrganisationId.make("other-org"));

		await expect(
			addVideosToFolder(folderId, [newId], spaceId),
		).resolves.toMatchObject({ success: false });

		expect(
			mocks.query.mock.calls.every(([query]) =>
				String(query).startsWith("select"),
			),
		).toBe(true);
	});

	it("does not write when the sharing lookup fails", async () => {
		setup([existingId], [existingId]);
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.query
			.mockResolvedValueOnce({ rows: [[folderId, orgId, spaceId]] })
			.mockResolvedValueOnce({ rows: [[existingId]] })
			.mockRejectedValueOnce(new Error("Database unavailable"));

		await expect(
			addVideosToFolder(folderId, [existingId], spaceId),
		).resolves.toMatchObject({ success: false });

		expect(
			mocks.query.mock.calls.every(([query]) =>
				String(query).startsWith("select"),
			),
		).toBe(true);
	});
});
