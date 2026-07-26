import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `canUserDownloadVideo` issues its queries in a fixed order, so each test
 * declares the rows every query returns, in order:
 *
 *   1. sharedVideos    - orgs this video was explicitly shared with
 *   2. organizationMembers - the user's membership in one of those orgs (only when 1 is non-empty)
 *   3. spaceVideos     - spaces this video sits in
 *   4. spaceMembers    - the user's membership in one of those spaces (only when 3 is non-empty)
 */
const mocks = vi.hoisted(() => {
	const queue: unknown[][] = [];
	let selectCalls = 0;

	const db = () => ({
		select: () => {
			selectCalls += 1;
			const rows = queue.shift() ?? [];
			// The production code awaits some chains directly and calls .limit()
			// on others, so the tail satisfies both shapes.
			const tail = {
				limit: async () => rows,
				then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
			};
			return { from: () => ({ where: () => tail }) };
		},
	});

	return {
		db,
		queue,
		reset() {
			queue.length = 0;
			selectCalls = 0;
		},
		get selectCalls() {
			return selectCalls;
		},
	};
});

vi.mock("@cap/database", () => ({ db: mocks.db }));

vi.mock("@cap/database/schema", () => ({
	organizationMembers: {
		id: "organizationMembers.id",
		userId: "organizationMembers.userId",
		organizationId: "organizationMembers.organizationId",
	},
	sharedVideos: {
		videoId: "sharedVideos.videoId",
		organizationId: "sharedVideos.organizationId",
	},
	spaceMembers: {
		id: "spaceMembers.id",
		userId: "spaceMembers.userId",
		spaceId: "spaceMembers.spaceId",
	},
	spaceVideos: {
		videoId: "spaceVideos.videoId",
		spaceId: "spaceVideos.spaceId",
	},
}));

import { canUserDownloadVideo } from "@/lib/video-download-permissions";

const request = (overrides: Record<string, string> = {}) =>
	({
		userId: "user-b",
		ownerId: "user-a",
		videoId: "video-1",
		...overrides,
	}) as Parameters<typeof canUserDownloadVideo>[0];

beforeEach(() => {
	mocks.reset();
});

describe("canUserDownloadVideo", () => {
	it("allows the owner without querying anything", async () => {
		await expect(
			canUserDownloadVideo(request({ userId: "user-a" })),
		).resolves.toBe(true);

		expect(mocks.selectCalls).toBe(0);
	});

	it("refuses a colleague when the video was never shared", async () => {
		// The video belongs to the owner's org, but no sharedVideos or
		// spaceVideos row exists. Membership of the owner's org is not a grant:
		// buildCanView requires an explicit share, and download must match it.
		mocks.queue.push([], []);

		await expect(canUserDownloadVideo(request())).resolves.toBe(false);

		// With no share rows there is nothing to match a membership against, so
		// neither membership lookup should run: 2 queries, not 4.
		expect(mocks.selectCalls).toBe(2);
	});

	it("allows a member of an org the video was explicitly shared with", async () => {
		mocks.queue.push(
			[{ organizationId: "org-shared" }],
			[{ id: "org-membership-1" }],
		);

		await expect(canUserDownloadVideo(request())).resolves.toBe(true);
	});

	it("refuses when shared to an org the user does not belong to", async () => {
		mocks.queue.push([{ organizationId: "org-shared" }], [], []);

		await expect(canUserDownloadVideo(request())).resolves.toBe(false);
	});

	it("allows a member of a space the video was shared into", async () => {
		mocks.queue.push([], [{ spaceId: "space-1" }], [{ id: "space-membership-1" }]);

		await expect(canUserDownloadVideo(request())).resolves.toBe(true);
	});

	it("refuses when the space is one the user does not belong to", async () => {
		mocks.queue.push([], [{ spaceId: "space-1" }], []);

		await expect(canUserDownloadVideo(request())).resolves.toBe(false);
	});
});
