import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const schema = {
	organizationMembers: { table: "organizationMembers" },
	sharedVideos: { table: "sharedVideos" },
	spaceMembers: { table: "spaceMembers" },
	spaceVideos: { table: "spaceVideos" },
};

vi.mock("@cap/database/schema", () => schema);

// Each select() call resolves against the next queued result, and the table it
// read is recorded so a test can assert which lookups actually happened.
let queued: unknown[][] = [];
const tablesRead: string[] = [];

const mockDb = {
	select: () => mockDb,
	from: (table: { table: string }) => {
		tablesRead.push(table.table);
		return mockDb;
	},
	where: () => {
		const rows = queued.shift() ?? [];
		const result = Promise.resolve(rows) as Promise<unknown[]> & {
			limit: () => Promise<unknown[]>;
		};
		result.limit = () => Promise.resolve(rows);
		return result;
	},
};

vi.mock("@cap/database", () => ({ db: () => mockDb }));

const { canUserDownloadVideo } = await import(
	"../../lib/video-download-permissions"
);

const OWNER = "user-owner" as User.UserId;
const OTHER = "user-other" as User.UserId;
const VIDEO = "video-1" as Video.VideoId;
const VIDEO_ORG = "org-owning-the-video" as Organisation.OrganisationId;

function call(userId: User.UserId) {
	return canUserDownloadVideo({ userId, ownerId: OWNER, videoId: VIDEO });
}

describe("canUserDownloadVideo", () => {
	beforeEach(() => {
		queued = [];
		tablesRead.length = 0;
	});

	it("allows the owner without querying shares", async () => {
		expect(await call(OWNER)).toBe(true);
		expect(tablesRead).toEqual([]);
	});

	// The video's own orgId must not grant download access: VideosPolicy.canView
	// requires an explicit sharedVideos row, and no creation path writes one, so
	// trusting orgId let org colleagues download videos they cannot open.
	it("denies an org colleague when the video was never explicitly shared", async () => {
		queued = [
			[], // sharedVideos: no explicit org share
			[], // spaceVideos: no space share
		];

		expect(await call(OTHER)).toBe(false);
		expect(tablesRead).toContain("sharedVideos");
		expect(tablesRead).not.toContain("organizationMembers");
	});

	it("allows a member of an org the video was explicitly shared with", async () => {
		queued = [
			[{ organizationId: VIDEO_ORG }], // sharedVideos
			[{ id: "membership-1" }], // organizationMembers
		];

		expect(await call(OTHER)).toBe(true);
		expect(tablesRead).toEqual(["sharedVideos", "organizationMembers"]);
	});

	it("denies a non-member even when the video is shared with some org", async () => {
		queued = [
			[{ organizationId: VIDEO_ORG }], // sharedVideos
			[], // organizationMembers: not a member
			[], // spaceVideos
		];

		expect(await call(OTHER)).toBe(false);
	});

	it("allows a member of a space the video was shared into", async () => {
		queued = [
			[], // sharedVideos
			[{ spaceId: "space-1" }], // spaceVideos
			[{ id: "space-membership-1" }], // spaceMembers
		];

		expect(await call(OTHER)).toBe(true);
		expect(tablesRead).toContain("spaceMembers");
	});

	it("denies a non-member of the space the video was shared into", async () => {
		queued = [
			[], // sharedVideos
			[{ spaceId: "space-1" }], // spaceVideos
			[], // spaceMembers
		];

		expect(await call(OTHER)).toBe(false);
	});
});
