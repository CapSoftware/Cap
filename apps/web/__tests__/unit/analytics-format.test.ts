import { describe, expect, it } from "vitest";
import {
	formatCompact,
	formatPercent,
} from "@/app/(org)/dashboard/analytics/components/format";

describe("formatPercent", () => {
	it.each([
		[0, "0%"],
		[0.004, "<1%"],
		[0.42, "42%"],
		[0.99, "99%"],
		[0.992, ">99%"],
		[0.996, ">99%"],
		[1, "100%"],
	])("formats %s as %s", (fraction, expected) => {
		expect(formatPercent(fraction)).toBe(expected);
	});

	it("never shows a share that is not every view as 100%", () => {
		const total = 251;
		expect(formatPercent(250 / total)).toBe(">99%");
		expect(formatPercent(1 / total)).toBe("<1%");
	});
});

describe("formatCompact", () => {
	it.each([
		[999, "999"],
		[1_000, "1.0k"],
		[9_949, "9.9k"],
		[9_950, "10k"],
		[9_999, "10k"],
		[10_000, "10k"],
		[999_499, "999k"],
		[999_500, "1.0M"],
		[999_999, "1.0M"],
		[1_000_000, "1.0M"],
		[9_949_999, "9.9M"],
		[9_950_000, "10M"],
		[9_999_999, "10M"],
		[10_000_000, "10M"],
	])("formats %s as %s", (value, expected) => {
		expect(formatCompact(value)).toBe(expected);
	});
});
