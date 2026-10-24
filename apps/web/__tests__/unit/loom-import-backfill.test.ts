import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selects: [] as unknown[][],
	updates: [] as Array<Record<string, unknown>>,
	inserts: [] as Array<Record<string, unknown>>,
	member: vi.fn(),
	provision: vi.fn(),
	reassign: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => {
	const selection = {
		from: () => selection,
		innerJoin: () => selection,
		where: () => selection,
		limit: async () => mocks.selects.shift() ?? [],
	};
	return {
		db: () => ({
			select: () => selection,
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						mocks.updates.push(values);
					},
				}),
			}),
			insert: () => ({
				values: async (values: Record<string, unknown>) => {
					mocks.inserts.push(values);
				},
			}),
		}),
	};
});
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "shareaaaaaaaaaa" }));
vi.mock("@cap/database/schema", () => ({
	folders: { id: "f.id", organizationId: "f.org", spaceId: "f.space" },
	importedVideos: { id: "i.id", orgId: "i.org", source: "i.source" },
	organizations: { id: "o.id", ownerId: "o.owner" },
	sharedVideos: {
		id: "s.id",
		videoId: "s.video",
		organizationId: "s.org",
		folderId: "s.folder",
	},
	videos: {
		id: "v.id",
		ownerId: "v.owner",
		orgId: "v.org",
		folderId: "v.folder",
		effectiveCreatedAt: "v.date",
		metadata: "v.metadata",
	},
}));
vi.mock("@/lib/loom-csv-import", () => ({
	getOrganizationMemberByEmail: mocks.member,
}));
vi.mock("@/lib/organization-provisioning", () => ({
	provisionOrganizationInvitee: mocks.provision,
}));
vi.mock("@/lib/loom-import-reassign", () => ({
	reassignLoomImport: mocks.reassign,
}));

import { backfillLoomImport } from "@/lib/loom-import-backfill";

const org = "orgaaaaaaaaaaaa";
const video = (overrides: Record<string, unknown> = {}) => ({
	ownerId: "lukeaaaaaaaaaaa",
	folderId: "folderaaaaaaaaa",
	effectiveCreatedAt: new Date("2026-09-23T10:00:00Z"),
	orgOwnerId: "lukeaaaaaaaaaaa",
	...overrides,
});

beforeEach(() => {
	mocks.selects = [];
	mocks.updates = [];
	mocks.inserts = [];
	mocks.member.mockReset().mockResolvedValue({ userId: "mdaueraaaaaaaaa" });
	mocks.provision.mockReset().mockResolvedValue({ userId: "newaaaaaaaaaaaa" });
	mocks.reassign
		.mockReset()
		.mockResolvedValue({ status: "moved", copiedObjects: 3, cleanup: "done" });
});

describe("backfillLoomImport", () => {
	it("moves the owner without touching sharing, keeping the sheet folder", async () => {
		mocks.selects = [[video()], [{ id: "folderbbbbbbbbb" }]];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				ownerEmail: "MDauer@greenprojecttech.com",
				folderId: "folderbbbbbbbbb",
			}),
		).resolves.toEqual({
			videoId: "videoaaaaaaaaaa",
			status: "updated",
			changes: ["owner", "folder"],
		});
		expect(mocks.member).toHaveBeenCalledWith(
			org,
			"mdauer@greenprojecttech.com",
		);
		expect(mocks.reassign).toHaveBeenCalledWith({
			organizationId: org,
			videoId: "videoaaaaaaaaaa",
			fromUserId: "lukeaaaaaaaaaaa",
			toUserId: "mdaueraaaaaaaaa",
			options: { keepSharing: true, folderId: "folderbbbbbbbbb" },
		});
		expect(mocks.updates).toEqual([]);
	});

	it("adds an owner who is not in the workspace yet", async () => {
		mocks.selects = [[video()]];
		mocks.member.mockResolvedValue(null);
		await backfillLoomImport(org, {
			videoId: "videoaaaaaaaaaa",
			ownerEmail: "zephy@greenprojecttech.com",
		});
		expect(mocks.provision).toHaveBeenCalledWith({
			organizationId: org,
			email: "zephy@greenprojecttech.com",
			invitedByUserId: "lukeaaaaaaaaaaa",
			role: "member",
		});
		expect(mocks.reassign).toHaveBeenCalledWith(
			expect.objectContaining({ toUserId: "newaaaaaaaaaaaa" }),
		);
	});

	it("leaves the owner alone when it already matches", async () => {
		mocks.selects = [[video()]];
		mocks.member.mockResolvedValue({ userId: "lukeaaaaaaaaaaa" });
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				ownerEmail: "luke@greenprojecttech.com",
			}),
		).resolves.toMatchObject({ status: "unchanged" });
		expect(mocks.reassign).not.toHaveBeenCalled();
	});

	it("sets the original date and the folder", async () => {
		mocks.selects = [[video({ folderId: null })], [{ id: "folderbbbbbbbbb" }]];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				folderId: "folderbbbbbbbbb",
				effectiveCreatedAt: "2023-09-14T16:11:20.773Z",
			}),
		).resolves.toMatchObject({ changes: ["folder", "date"] });
		expect(mocks.updates[0]).toEqual({ folderId: "folderbbbbbbbbb" });
		expect(mocks.updates).toHaveLength(2);
	});

	it("skips a date that already matches", async () => {
		mocks.selects = [[video()]];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				effectiveCreatedAt: "2026-09-23T10:00:00.000Z",
			}),
		).resolves.toMatchObject({ status: "unchanged" });
	});

	it("shares into the team folder once", async () => {
		mocks.selects = [[video()], [{ id: "teamfolderaaaaa" }], []];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				shareFolderId: "teamfolderaaaaa",
			}),
		).resolves.toMatchObject({ changes: ["shared"] });
		expect(mocks.inserts[0]).toMatchObject({
			videoId: "videoaaaaaaaaaa",
			organizationId: org,
			folderId: "teamfolderaaaaa",
		});
		mocks.selects = [
			[video()],
			[{ id: "teamfolderaaaaa" }],
			[{ id: "share", folderId: "teamfolderaaaaa" }],
		];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				shareFolderId: "teamfolderaaaaa",
			}),
		).resolves.toMatchObject({ status: "unchanged" });
		expect(mocks.inserts).toHaveLength(1);
	});

	it.each([
		[[], "not a Loom import here"],
		[[video(), []], "folder not in this workspace"],
	])("refuses unsafe changes: %#", async (selects, reason) => {
		mocks.selects = (selects as unknown[]).map((row) =>
			Array.isArray(row) ? row : [row],
		);
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				folderId: "folderbbbbbbbbb",
				ownerEmail: "x@y.co",
			}),
		).resolves.toMatchObject({ status: "skipped", reason });
		expect(mocks.reassign).not.toHaveBeenCalled();
	});

	it("reports a move it could not make", async () => {
		mocks.selects = [[video()]];
		mocks.reassign.mockResolvedValue({
			status: "skipped",
			reason: "edited video",
		});
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				ownerEmail: "mdauer@greenprojecttech.com",
			}),
		).resolves.toMatchObject({ status: "skipped", reason: "edited video" });
	});
});
