import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadLimits = async () => {
	vi.resetModules();
	return {
		...(await import("@/lib/comment-rate-limit")),
		...(await import("@/lib/rate-limit")),
	};
};

describe("comment and invite budgets without a firewall answer", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("allows sixty comments a minute per author", async () => {
		const { isCommentRateLimited } = await loadLimits();
		const results = [];
		for (let index = 0; index < 61; index += 1) {
			results.push(await isCommentRateLimited("author-one"));
		}

		expect(results.slice(0, 60).every((limited) => !limited)).toBe(true);
		expect(results[60]).toBe(true);
		expect(await isCommentRateLimited("author-two")).toBe(false);

		vi.setSystemTime(new Date("2026-11-05T10:01:01Z"));
		expect(await isCommentRateLimited("author-one")).toBe(false);
	});

	it("allows thirty viewer invite emails an hour per owner", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadLimits();
		const invite = (owner: string) =>
			isRateLimited(RATE_LIMIT_IDS.ORGANIZATION_INVITE, {
				key: `video-viewer-invite:user:${owner}`,
			});
		const results = [];
		for (let index = 0; index < 31; index += 1) {
			results.push(await invite("owner-one"));
		}

		expect(results.slice(0, 30).every((limited) => !limited)).toBe(true);
		expect(results[30]).toBe(true);

		vi.setSystemTime(new Date("2026-11-05T10:59:00Z"));
		expect(await invite("owner-one")).toBe(true);
		expect(
			await isRateLimited(RATE_LIMIT_IDS.ORGANIZATION_INVITE, {
				key: "organization-invite:user:owner-one",
			}),
		).toBe(false);

		vi.setSystemTime(new Date("2026-11-05T11:00:01Z"));
		expect(await invite("owner-one")).toBe(false);
	});
});
