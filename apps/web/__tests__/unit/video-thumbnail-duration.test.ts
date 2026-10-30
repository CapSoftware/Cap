import { describe, expect, it } from "vitest";
import { formatDuration } from "../../lib/date-format";

describe("formatDuration", () => {
	it("formats sub-minute fractional durations without showing 60 secs (#3563)", () => {
		expect(formatDuration(59.0)).toBe("59 secs");
		expect(formatDuration(59.2)).toBe("1 min");
		expect(formatDuration(59.5)).toBe("1 min");
		expect(formatDuration(59.99)).toBe("1 min");
		expect(formatDuration(60.0)).toBe("1 min");
	});

	it("formats sub-second and small second durations", () => {
		expect(formatDuration(0)).toBe("< 1 sec");
		expect(formatDuration(-1)).toBe("< 1 sec");
		expect(formatDuration(0.4)).toBe("1 sec");
		expect(formatDuration(1.0)).toBe("1 sec");
		expect(formatDuration(8.0)).toBe("8 secs");
	});

	it("formats multi-minute durations properly", () => {
		expect(formatDuration(61.0)).toBe("1 min");
		expect(formatDuration(119.5)).toBe("2 mins");
		expect(formatDuration(120.0)).toBe("2 mins");
		expect(formatDuration(125.0)).toBe("2 mins");
	});

	it("formats hour-level durations and handles hour rollovers", () => {
		expect(formatDuration(3599.5)).toBe("1 hr");
		expect(formatDuration(3600.0)).toBe("1 hr");
		expect(formatDuration(7200.0)).toBe("2 hrs");
	});
});
