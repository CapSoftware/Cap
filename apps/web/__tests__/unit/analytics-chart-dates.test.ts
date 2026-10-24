import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatBucketTick,
	formatBucketTitle,
	formatRelative,
	granularityOf,
} from "@/app/(org)/dashboard/analytics/components/format";

describe.each(["America/Los_Angeles", "Asia/Kolkata", "UTC"])(
	"analytics chart dates in %s",
	(timeZone) => {
		beforeEach(() => vi.stubEnv("TZ", timeZone));
		afterEach(() => vi.unstubAllEnvs());

		it.each([
			"2026-01-01T00:00:00Z",
			"2026-03-08T00:00:00Z",
			"2026-11-01T00:00:00Z",
		])("labels UTC daily buckets on their actual date: %s", (bucket) => {
			const expected = new Date(bucket).toLocaleDateString([], {
				day: "numeric",
				month: "short",
				timeZone: "UTC",
			});
			expect(formatBucketTick(bucket, "day", 7)).toBe(expected);
			expect(formatBucketTitle(bucket, "day")).toContain(
				new Date(bucket).toLocaleDateString([], {
					day: "numeric",
					timeZone: "UTC",
				}),
			);
		});

		it("keeps hourly labels in the viewer's local time", () => {
			const bucket = "2026-01-01T01:00:00Z";
			expect(formatBucketTick(bucket, "hour", 1)).toBe(
				new Date(bucket).toLocaleTimeString([], { hour: "numeric" }),
			);
		});
	},
);

describe("formatRelative", () => {
	const now = Date.UTC(2026, 9, 24, 15, 30);

	it("describes daily buckets against the UTC day", () => {
		expect(formatRelative("2026-10-24T00:00:00Z", "day", now)).toBe("Today");
		expect(formatRelative("2026-10-23T00:00:00Z", "day", now)).toBe(
			"Yesterday",
		);
		expect(formatRelative("2026-10-13T00:00:00Z", "day", now)).toBe(
			"11 days ago",
		);
	});

	it("describes hourly buckets in hours", () => {
		expect(formatRelative("2026-10-24T15:00:00Z", "hour", now)).toBe(
			"This hour",
		);
		expect(formatRelative("2026-10-24T12:00:00Z", "hour", now)).toBe(
			"3 hours ago",
		);
	});
});

describe("granularityOf", () => {
	it("detects hourly buckets from their spacing", () => {
		expect(
			granularityOf([
				{ bucket: "2026-10-24T01:00:00Z" },
				{ bucket: "2026-10-24T02:00:00Z" },
			]),
		).toBe("hour");
	});

	it("treats daily or missing buckets as daily", () => {
		expect(
			granularityOf([
				{ bucket: "2026-10-23T00:00:00Z" },
				{ bucket: "2026-10-24T00:00:00Z" },
			]),
		).toBe("day");
		expect(granularityOf([])).toBe("day");
	});
});

describe("weekly titles", () => {
	it("uses the bucket's real end date when the week is short", () => {
		expect(
			formatBucketTitle(
				"2026-07-01T00:00:00Z",
				"week",
				"2026-07-03T00:00:00Z",
				Date.parse("2026-10-24T12:00:00Z"),
			),
		).toBe(
			`${new Date("2026-07-01T00:00:00Z").toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" })} to ${new Date("2026-07-03T00:00:00Z").toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" })}`,
		);
	});
});

describe("dates from other years", () => {
	const now = Date.parse("2026-10-24T12:00:00Z");
	const withYear = (iso: string) =>
		new Date(iso).toLocaleDateString([], {
			day: "numeric",
			month: "short",
			year: "numeric",
			timeZone: "UTC",
		});

	it("adds the year to day and week titles outside the current year", () => {
		expect(
			formatBucketTitle("2024-06-28T00:00:00Z", "day", undefined, now),
		).toContain("2024");
		expect(
			formatBucketTitle("2026-06-28T00:00:00Z", "day", undefined, now),
		).not.toContain("2026");
		expect(
			formatBucketTitle(
				"2024-06-28T00:00:00Z",
				"week",
				"2024-07-04T00:00:00Z",
				now,
			),
		).toBe(
			`${withYear("2024-06-28T00:00:00Z")} to ${withYear("2024-07-04T00:00:00Z")}`,
		);
		expect(
			formatBucketTitle(
				"2025-12-29T00:00:00Z",
				"week",
				"2026-01-04T00:00:00Z",
				now,
			),
		).toBe(
			`${withYear("2025-12-29T00:00:00Z")} to ${withYear("2026-01-04T00:00:00Z")}`,
		);
	});

	it("counts whole years for old buckets", () => {
		expect(formatRelative("2024-03-08T00:00:00Z", "week", now)).toBe(
			"2 years ago",
		);
	});

	it("labels multi-year ticks with the full year", () => {
		expect(formatBucketTick("2024-04-01T00:00:00Z", "week", 900)).toBe(
			new Date("2024-04-01T00:00:00Z").toLocaleDateString([], {
				month: "short",
				year: "numeric",
				timeZone: "UTC",
			}),
		);
		expect(formatBucketTick("2024-04-01T00:00:00Z", "week", 900)).toContain(
			"2024",
		);
	});
});
