import {
	FREE_SHAREABLE_LINK_LIMIT,
	FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS,
	getShareableLinkPeriod,
	getShareableLinkUsageLimitError,
	isShareableLinkUsageLimitError,
	toShareableLinkUsageSnapshot,
} from "@cap/web-backend";
import { describe, expect, it } from "vitest";

describe("shareable link usage", () => {
	it("uses UTC calendar month boundaries", () => {
		const period = getShareableLinkPeriod(new Date("2026-05-31T23:59:59.000Z"));

		expect(period.periodStart.toISOString()).toBe("2026-05-01T00:00:00.000Z");
		expect(period.periodEnd.toISOString()).toBe("2026-06-01T00:00:00.000Z");
		expect(period.resetAt).toBe("2026-06-01T00:00:00.000Z");
	});

	it("formats remaining usage", () => {
		const usage = toShareableLinkUsageSnapshot(12, "2026-06-01T00:00:00.000Z");

		expect(usage).toEqual({
			used: 12,
			limit: FREE_SHAREABLE_LINK_LIMIT,
			remaining: 18,
			resetAt: "2026-06-01T00:00:00.000Z",
			maxDurationSeconds: FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS,
		});
	});

	it("allows the thirtieth shareable link", () => {
		const error = getShareableLinkUsageLimitError({
			used: FREE_SHAREABLE_LINK_LIMIT - 1,
			resetAt: "2026-06-01T00:00:00.000Z",
			durationSeconds: FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS,
		});

		expect(error).toBeNull();
	});

	it("blocks after the monthly limit is reached", () => {
		const error = getShareableLinkUsageLimitError({
			used: FREE_SHAREABLE_LINK_LIMIT,
			resetAt: "2026-06-01T00:00:00.000Z",
			durationSeconds: FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS,
		});

		expect(error?._tag).toBe("ShareableLinkUsageLimitError");
		expect(error?.reason).toBe("shareable_link_limit");
		expect(error?.usage.remaining).toBe(0);
	});

	it("blocks videos over the free duration limit", () => {
		const error = getShareableLinkUsageLimitError({
			used: 0,
			resetAt: "2026-06-01T00:00:00.000Z",
			durationSeconds: FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS + 1,
		});

		expect(error?._tag).toBe("ShareableLinkUsageLimitError");
		expect(error?.reason).toBe("duration_limit");
	});

	it("detects shareable link limit errors wrapped as causes", () => {
		const error = getShareableLinkUsageLimitError({
			used: FREE_SHAREABLE_LINK_LIMIT,
			resetAt: "2026-06-01T00:00:00.000Z",
		});

		const wrapped = new Error("upgrade_required", { cause: error });

		expect(isShareableLinkUsageLimitError(wrapped)).toBe(true);
	});
});
