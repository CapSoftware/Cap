import { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: true } }));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});

import { isVideoLockedByShareableLinkLimit } from "@/lib/shareable-link-quota";

const VIDEO = Video.VideoId.make("video-1");

let videoRow: unknown[] | undefined;
let earlierVideos: number;

beforeEach(() => {
	videoRow = ["user-owner", "2026-10-20 12:00:00", 0, "canceled", null];
	earlierVideos = Video.FREE_PLAN_SHAREABLE_LINKS_PER_MONTH;
	mocks.query.mockReset().mockImplementation(async (query: string) => {
		if (query.includes("left join `users`")) {
			return { rows: videoRow ? [videoRow] : [] };
		}
		if (query.includes("count(")) {
			return { rows: [[earlierVideos]] };
		}
		throw new Error(`unexpected query: ${query}`);
	});
});

const countQueries = () =>
	mocks.query.mock.calls.filter(([query]) => String(query).includes("count("))
		.length;

describe("isVideoLockedByShareableLinkLimit", () => {
	it("locks a video past the monthly allowance once its owner is no longer Pro", async () => {
		expect(await isVideoLockedByShareableLinkLimit(VIDEO)).toBe(true);

		earlierVideos = Video.FREE_PLAN_SHAREABLE_LINKS_PER_MONTH - 1;
		expect(await isVideoLockedByShareableLinkLimit(VIDEO)).toBe(false);
	});

	it("never locks a Pro owner's video and skips the count", async () => {
		videoRow = ["user-owner", "2026-10-20 12:00:00", 0, "active", null];
		expect(await isVideoLockedByShareableLinkLimit(VIDEO)).toBe(false);

		videoRow = ["user-owner", "2026-10-20 12:00:00", 0, null, "sub_third"];
		expect(await isVideoLockedByShareableLinkLimit(VIDEO)).toBe(false);
		expect(countQueries()).toBe(0);
	});

	it("never locks screenshots or videos from before enforcement", async () => {
		videoRow = ["user-owner", "2026-10-20 12:00:00", 1, null, null];
		expect(await isVideoLockedByShareableLinkLimit(VIDEO)).toBe(false);

		videoRow = ["user-owner", "2026-08-01 12:00:00", 0, null, null];
		expect(await isVideoLockedByShareableLinkLimit(VIDEO)).toBe(false);
		expect(countQueries()).toBe(0);
	});

	it("treats a missing video as unlocked", async () => {
		videoRow = undefined;
		expect(await isVideoLockedByShareableLinkLimit(VIDEO)).toBe(false);
	});
});
