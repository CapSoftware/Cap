import { describe, expect, it } from "vitest";
import { formatEstimatedSize, formatEstimatedTime } from "./export-estimates";

describe("export estimate labels", () => {
	it("keeps measured variation visible", () => {
		expect(formatEstimatedSize([18.7, 31.5])).toBe("~19–32 MB");
		expect(formatEstimatedTime([17.6, 18.9])).toBe("~18–19 s");
	});

	it("uses useful precision across unit boundaries", () => {
		expect(formatEstimatedSize([900, 1200])).toBe("~0.9–1.2 GB");
		expect(formatEstimatedTime([59, 90])).toBe("~1–1.5 min");
		expect(formatEstimatedTime([3600, 5400])).toBe("~1–1.5 hr");
	});

	it("avoids false zero or duplicated ranges for tiny exports", () => {
		expect(formatEstimatedTime([0.1, 0.9])).toBe("< 1s");
		expect(formatEstimatedSize([0.1, 0.9])).toBe("< 1 MB");
		expect(formatEstimatedTime([2.1, 2.3])).toBe("~2 s");
	});
});
