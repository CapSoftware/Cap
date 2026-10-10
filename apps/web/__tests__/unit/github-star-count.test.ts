import { describe, expect, it } from "vitest";
import { formatStarCount } from "@/utils/github";

describe("formatStarCount", () => {
	it("returns an empty string when the count is unavailable", () => {
		expect(formatStarCount(0)).toBe("");
	});

	it("returns counts below 1000 unchanged", () => {
		expect(formatStarCount(999)).toBe("999");
	});

	it("formats thousands with one decimal place", () => {
		expect(formatStarCount(16_420)).toBe("16.4k");
	});

	it("drops a trailing .0", () => {
		expect(formatStarCount(16_000)).toBe("16k");
		expect(formatStarCount(16_049)).toBe("16k");
	});

	it("rounds up to the next whole thousand", () => {
		expect(formatStarCount(16_960)).toBe("17k");
		expect(formatStarCount(19_999)).toBe("20k");
	});
});
