import { describe, expect, it } from "vitest";
import { formatDuration, formatRecordedDuration } from "./format-duration";

describe("recording durations", () => {
	it("keeps M:SS under an hour", () => {
		expect(formatDuration(0)).toBe("0:00");
		expect(formatDuration(95_700)).toBe("1:35");
		expect(formatDuration(3_599_999)).toBe("59:59");
		expect(formatRecordedDuration(400)).toBe("0:01");
		expect(formatRecordedDuration(95_500)).toBe("1:36");
	});

	it("shows hours from an hour on instead of counting minutes past 59", () => {
		expect(formatDuration(3_600_000)).toBe("1:00:00");
		expect(formatDuration(3_905_900)).toBe("1:05:05");
		expect(formatRecordedDuration(3_599_600)).toBe("1:00:00");
		expect(formatRecordedDuration(3_905_000)).toBe("1:05:05");
	});
});
