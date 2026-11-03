import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selects: [] as unknown[][],
	updates: [] as Array<Record<string, unknown>>,
	inserts: [] as Array<Record<string, unknown>>,
	shares: [] as unknown[][],
	deletes: 0,
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
		for: async () => [],
		then: (resolve: (rows: unknown[]) => void) =>
			resolve(mocks.shares.shift() ?? []),
	};
	const handle = {
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
		delete: () => ({
			where: async () => {
				mocks.deletes++;
			},
		}),
	};
	return {
		db: () => ({
			...handle,
			transaction: async (run: (tx: typeof handle) => Promise<unknown>) =>
				run(handle),
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
	normalizeImportEmail: (email: string) => email.trim().toLowerCase(),
	isValidImportEmail: (email: string) =>
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
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
	mocks.shares = [];
	mocks.deletes = 0;
	mocks.member.mockReset().mockResolvedValue({ userId: "mdaueraaaaaaaaa" });
	mocks.provision.mockReset().mockResolvedValue({ userId: "newaaaaaaaaaaaa" });
	mocks.reassign
		.mockReset()
		.mockResolvedValue({ status: "moved", copiedObjects: 3, cleanup: "done" });
});

const lukeFolder = (id = "folderbbbbbbbbb") => ({
	id,
	createdById: "lukeaaaaaaaaaaa",
});

describe("backfillLoomImport", () => {
	it("moves the owner without touching sharing, into the sheet folder", async () => {
		mocks.selects = [
			[video()],
			[lukeFolder()],
			[lukeFolder("folderaaaaaaaaa")],
		];
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

	it("clears an inherited folder the new owner could not open", async () => {
		mocks.selects = [
			[video({ orgOwnerId: "owneraaaaaaaaaa" })],
			[{ id: "folderaaaaaaaaa", createdById: "lukeaaaaaaaaaaa" }],
		];
		await backfillLoomImport(org, {
			videoId: "videoaaaaaaaaaa",
			ownerEmail: "mdauer@greenprojecttech.com",
		});
		expect(mocks.reassign).toHaveBeenCalledWith(
			expect.objectContaining({
				options: { keepSharing: true, folderId: null },
			}),
		);
	});

	it("adds an owner who is not in the workspace yet", async () => {
		mocks.selects = [[video()], [lukeFolder("folderaaaaaaaaa")]];
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

	it("never creates accounts for invalid owner emails", async () => {
		mocks.selects = [[video()]];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				ownerEmail: "unknown",
			}),
		).resolves.toMatchObject({
			status: "skipped",
			reason: "invalid owner email",
		});
		expect(mocks.member).not.toHaveBeenCalled();
		expect(mocks.provision).not.toHaveBeenCalled();
	});

	it("leaves the owner alone when it already matches", async () => {
		mocks.selects = [[video()], [lukeFolder("folderaaaaaaaaa")]];
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
		mocks.selects = [[video({ folderId: null })], [lukeFolder()]];
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
		mocks.selects = [[video()], [lukeFolder("folderaaaaaaaaa")]];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				effectiveCreatedAt: "2026-09-23T10:00:00.000Z",
			}),
		).resolves.toMatchObject({ status: "unchanged" });
	});

	it("shares into the team folder once and folds duplicate shares", async () => {
		mocks.selects = [
			[video()],
			[lukeFolder("teamfolderaaaaa")],
			[lukeFolder("folderaaaaaaaaa")],
		];
		mocks.shares = [[]];
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
			[lukeFolder("teamfolderaaaaa")],
			[lukeFolder("folderaaaaaaaaa")],
		];
		mocks.shares = [
			[
				{ id: "share1", folderId: "teamfolderaaaaa" },
				{ id: "share2", folderId: "otherfolderaaaa" },
			],
		];
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				shareFolderId: "teamfolderaaaaa",
			}),
		).resolves.toMatchObject({ changes: ["shared"] });
		expect(mocks.deletes).toBe(1);
		expect(mocks.inserts).toHaveLength(1);
	});

	it.each([
		[[], "not a Loom import here"],
		[[video(), []], "folder not in this workspace"],
		[
			[video(), [{ id: "folderbbbbbbbbb", createdById: "someoneaaaaaaaa" }]],
			"folder belongs to someone other than the owner",
		],
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

	it("repairs a pending conversion left on the previous owner's path", async () => {
		mocks.selects = [
			[
				video({
					ownerId: "zephyaaaaaaaaaa",
					metadata: {
						loomDeferredProcessing: {
							status: "pending",
							rawFileKey: "lukeaaaaaaaaaaa/videoaaaaaaaaaa/raw-upload.webm",
						},
					},
				}),
			],
			[lukeFolder("folderaaaaaaaaa")],
		];
		await expect(
			backfillLoomImport(org, { videoId: "videoaaaaaaaaaa" }),
		).resolves.toMatchObject({ status: "updated", changes: ["original"] });
		expect(mocks.updates).toHaveLength(1);
		const query = new MySqlDialect().sqlToQuery(
			mocks.updates[0]?.metadata as SQL,
		);
		expect(query.sql).toContain(
			"JSON_SET(?, '$.loomDeferredProcessing.rawFileKey', ?)",
		);
		expect(query.params).toContain(
			"zephyaaaaaaaaaa/videoaaaaaaaaaa/raw-upload.webm",
		);
	});

	it("leaves a conversion already on the owner's path alone", async () => {
		mocks.selects = [
			[
				video({
					metadata: {
						loomDeferredProcessing: {
							status: "pending",
							rawFileKey: "lukeaaaaaaaaaaa/videoaaaaaaaaaa/raw-upload.webm",
						},
					},
				}),
			],
			[lukeFolder("folderaaaaaaaaa")],
		];
		await expect(
			backfillLoomImport(org, { videoId: "videoaaaaaaaaaa" }),
		).resolves.toMatchObject({ status: "unchanged" });
	});

	it("reports moves it could not make or finish cleaning up", async () => {
		mocks.selects = [[video()], [lukeFolder("folderaaaaaaaaa")]];
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
		mocks.selects = [[video()], [lukeFolder("folderaaaaaaaaa")]];
		mocks.reassign.mockResolvedValue({
			status: "moved",
			copiedObjects: 3,
			cleanup: "failed",
		});
		await expect(
			backfillLoomImport(org, {
				videoId: "videoaaaaaaaaaa",
				ownerEmail: "mdauer@greenprojecttech.com",
			}),
		).resolves.toMatchObject({
			status: "updated",
			warning: "old owner's files could not be removed",
		});
	});
});
