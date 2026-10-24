import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatBucketTick,
	formatBucketTitle,
	formatRelative,
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
