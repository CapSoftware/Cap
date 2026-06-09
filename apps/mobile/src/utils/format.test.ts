import { describe, expect, it } from "vitest";
import { formatDuration, formatFileSize, formatRelativeDate } from "./format";

describe("mobile formatters", () => {
	it("formats card dates like Cap web", () => {
		const now = new Date("2026-05-18T11:00:00.000Z");

		expect(formatRelativeDate("2026-05-18T10:30:00.000Z", now)).toBe(
			"30 minutes ago",
		);
		expect(formatRelativeDate("2026-05-18T09:45:00.000Z", now)).toBe(
			"an hour ago",
		);
		expect(formatRelativeDate("2026-05-16T11:00:00.000Z", now)).toBe(
			"2 days ago",
		);
	});

	it("formats card durations like Cap web thumbnails", () => {
		expect(formatDuration(0)).toBe("< 1 sec");
		expect(formatDuration(8)).toBe("8 secs");
		expect(formatDuration(61)).toBe("1 min");
		expect(formatDuration(125)).toBe("2 mins");
		expect(formatDuration(7200)).toBe("2 hrs");
	});

	it("formats native upload file sizes", () => {
		expect(formatFileSize(null)).toBeNull();
		expect(formatFileSize(0)).toBeNull();
		expect(formatFileSize(640)).toBe("640 B");
		expect(formatFileSize(124_000)).toBe("124 KB");
		expect(formatFileSize(12_400_000)).toBe("12 MB");
		expect(formatFileSize(2_300_000_000)).toBe("2 GB");
	});
});
