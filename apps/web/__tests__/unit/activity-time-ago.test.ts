import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "../../app/s/[videoId]/_components/tabs/Activity/utils";

describe("formatTimeAgo", () => {
	const now = new Date("2026-10-30T12:00:00.000Z");

	const dateDaysAgo = (days: number) =>
		new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

	it("formats 360–364 day old items as 1y ago instead of 0y ago (#3562)", () => {
		expect(formatTimeAgo(dateDaysAgo(359), now)).toBe("11mo ago");
		expect(formatTimeAgo(dateDaysAgo(360), now)).toBe("1y ago");
		expect(formatTimeAgo(dateDaysAgo(362), now)).toBe("1y ago");
		expect(formatTimeAgo(dateDaysAgo(364), now)).toBe("1y ago");
		expect(formatTimeAgo(dateDaysAgo(365), now)).toBe("1y ago");
	});

	it("formats seconds, minutes, hours, and days", () => {
		expect(formatTimeAgo(new Date(now.getTime() - 30 * 1000), now)).toBe("now");
		expect(formatTimeAgo(new Date(now.getTime() - 5 * 60 * 1000), now)).toBe("5m ago");
		expect(formatTimeAgo(new Date(now.getTime() - 3 * 3600 * 1000), now)).toBe("3h ago");
		expect(formatTimeAgo(dateDaysAgo(1), now)).toBe("1d ago");
		expect(formatTimeAgo(dateDaysAgo(29), now)).toBe("29d ago");
	});

	it("formats multi-year durations", () => {
		expect(formatTimeAgo(dateDaysAgo(729), now)).toBe("1y ago");
		expect(formatTimeAgo(dateDaysAgo(730), now)).toBe("2y ago");
		expect(formatTimeAgo(dateDaysAgo(1095), now)).toBe("3y ago");
	});
});
