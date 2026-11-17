import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTimeAgo } from "@/app/s/[videoId]/_components/tabs/Activity/utils";

const NOW = new Date("2026-10-30T12:00:00Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe("formatTimeAgo", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows months until twelve thirty-day months have passed", () => {
		expect(formatTimeAgo(daysAgo(30))).toBe("1mo ago");
		expect(formatTimeAgo(daysAgo(359))).toBe("11mo ago");
	});

	it("never shows zero years between 360 and 364 days", () => {
		for (const days of [360, 362, 364]) {
			expect(formatTimeAgo(daysAgo(days))).toBe("1y ago");
		}
	});

	it("counts whole years after that", () => {
		expect(formatTimeAgo(daysAgo(365))).toBe("1y ago");
		expect(formatTimeAgo(daysAgo(729))).toBe("1y ago");
		expect(formatTimeAgo(daysAgo(730))).toBe("2y ago");
	});
});
