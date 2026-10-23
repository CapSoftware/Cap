import { describe, expect, it } from "vitest";
import { formatPlayerTime } from "@/lib/player-time";

describe("formatPlayerTime", () => {
	it("pads minutes and seconds under an hour", () => {
		expect(formatPlayerTime(0.4)).toBe("00:00");
		expect(formatPlayerTime(9)).toBe("00:09");
		expect(formatPlayerTime(63)).toBe("01:03");
		expect(formatPlayerTime(3599)).toBe("59:59");
	});

	it("rolls over into hours instead of counting past 59 minutes", () => {
		expect(formatPlayerTime(3600)).toBe("1:00:00");
		expect(formatPlayerTime(3825)).toBe("1:03:45");
		expect(formatPlayerTime(7384)).toBe("2:03:04");
		expect(formatPlayerTime(36000)).toBe("10:00:00");
	});

	it("truncates fractional seconds rather than rounding up", () => {
		expect(formatPlayerTime(59.9)).toBe("00:59");
		expect(formatPlayerTime(3599.9)).toBe("59:59");
	});

	it("falls back to zero for non-finite or non-positive input", () => {
		expect(formatPlayerTime(0)).toBe("00:00");
		expect(formatPlayerTime(-5)).toBe("00:00");
		expect(formatPlayerTime(Number.NaN)).toBe("00:00");
		expect(formatPlayerTime(Number.POSITIVE_INFINITY)).toBe("00:00");
	});
});
