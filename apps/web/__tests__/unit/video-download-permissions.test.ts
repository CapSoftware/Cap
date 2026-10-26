import { User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});

import { canUserDownloadVideo } from "@/lib/video-download-permissions";

const OWNER = User.UserId.make("user-owner");
const OTHER = User.UserId.make("user-other");
const VIDEO = Video.VideoId.make("video-1");
let organizationShared: boolean;
let organizationMember: boolean;
let spaceShared: boolean;
let spaceMember: boolean;

function call(userId = OTHER) {
	return canUserDownloadVideo({ userId, ownerId: OWNER, videoId: VIDEO });
}

beforeEach(() => {
	organizationShared = false;
	organizationMember = false;
	spaceShared = false;
	spaceMember = false;
	mocks.query.mockImplementation(async (query: string, params: unknown[]) => {
		if (query.includes("inner join")) {
			const organization = query.includes("`organization_members`");
			const membershipTable = organization
				? "organization_members"
				: "space_members";
			const shareTable = organization ? "shared_videos" : "space_videos";
			const key = organization ? "organizationId" : "spaceId";
			expect(query).toContain(
				`\`${shareTable}\`.\`${key}\` = \`${membershipTable}\`.\`${key}\``,
			);
			expect(query).toContain(`\`${membershipTable}\`.\`userId\` = ?`);
			expect(query).toContain(`\`${shareTable}\`.\`videoId\` = ?`);
			expect(query).toContain("limit ?");
			expect(params).toEqual([OTHER, VIDEO, 1]);
			const allowed = organization
				? organizationShared && organizationMember
				: spaceShared && spaceMember;
			return { rows: allowed ? [["membership-1"]] : [] };
		}
		if (query.includes("from `shared_videos`")) {
			return { rows: organizationShared ? [["org-1"]] : [] };
		}
		if (query.includes("from `organization_members`")) {
			return { rows: organizationMember ? [["membership-1"]] : [] };
		}
		if (query.includes("from `space_videos`")) {
			return { rows: spaceShared ? [["space-1"]] : [] };
		}
		if (query.includes("from `space_members`")) {
			return { rows: spaceMember ? [["membership-1"]] : [] };
		}
		throw new Error(`Unexpected query: ${query}`);
	});
});

describe("canUserDownloadVideo", () => {
	it("allows the owner without querying shares", async () => {
		expect(await call(OWNER)).toBe(true);
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it.each([
		[false, false, false, false],
		[false, false, false, true],
		[false, false, true, false],
		[false, false, true, true],
		[false, true, false, false],
		[false, true, false, true],
		[false, true, true, false],
		[false, true, true, true],
		[true, false, false, false],
		[true, false, false, true],
		[true, false, true, false],
		[true, false, true, true],
		[true, true, false, false],
		[true, true, false, true],
		[true, true, true, false],
		[true, true, true, true],
	])(
		"requires an explicit share and membership: org %s/%s, space %s/%s",
		async (orgShared, orgMember, sharedSpace, memberOfSpace) => {
			organizationShared = orgShared;
			organizationMember = orgMember;
			spaceShared = sharedSpace;
			spaceMember = memberOfSpace;
			expect(await call()).toBe(
				(orgShared && orgMember) || (sharedSpace && memberOfSpace),
			);
		},
	);

	it("checks both memberships in one round trip without loading share lists", async () => {
		const pending: Array<() => void> = [];
		mocks.query.mockImplementation(
			() =>
				new Promise((resolve) => {
					pending.push(() => resolve({ rows: [] }));
				}),
		);
		const result = call();
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		for (const release of pending) release();
		expect(await result).toBe(false);
		expect(mocks.query).toHaveBeenCalledTimes(2);
		expect(
			mocks.query.mock.calls.every(([query]) => query.includes("inner join")),
		).toBe(true);
	});

	it("allows an org member even when the prefetched space lookup fails", async () => {
		mocks.query.mockImplementation(async (query: string) => {
			if (query.includes("`space_videos`"))
				throw new Error("Space lookup failed");
			return { rows: [["organization-member"]] };
		});
		expect(await call()).toBe(true);
	});

	it("propagates an org lookup failure even when the space lookup succeeds", async () => {
		const failure = new Error("Organization lookup failed");
		mocks.query.mockImplementation(async (query: string) => {
			if (query.includes("`shared_videos`")) throw failure;
			return { rows: [["space-member"]] };
		});
		await expect(call()).rejects.toMatchObject({ cause: failure });
	});

	it("propagates a space lookup failure when there is no org membership", async () => {
		const failure = new Error("Space lookup failed");
		mocks.query.mockImplementation(async (query: string) => {
			if (query.includes("`space_videos`")) throw failure;
			return { rows: [] };
		});
		await expect(call()).rejects.toMatchObject({ cause: failure });
	});

	it("propagates database failures", async () => {
		mocks.query.mockRejectedValue(new Error("Database unavailable"));
		await expect(call()).rejects.toThrow();
	});
});
