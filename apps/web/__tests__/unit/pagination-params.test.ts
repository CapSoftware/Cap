import { describe, expect, it } from "vitest";
import { parseLimitParam, parsePageParam } from "../../lib/pagination";

describe("pagination params validation (#3567)", () => {
	describe("parsePageParam", () => {
		it("falls back to default page on missing, non-positive, or fractional input", () => {
			expect(parsePageParam(undefined)).toBe(1);
			expect(parsePageParam("")).toBe(1);
			expect(parsePageParam("0")).toBe(1);
			expect(parsePageParam("-1")).toBe(1);
			expect(parsePageParam("-10")).toBe(1);
			expect(parsePageParam("1.5")).toBe(1);
			expect(parsePageParam("abc")).toBe(1);
			expect(parsePageParam(NaN as unknown as string)).toBe(1);
		});

		it("parses valid positive integer pages", () => {
			expect(parsePageParam("1")).toBe(1);
			expect(parsePageParam("5")).toBe(5);
			expect(parsePageParam(["3", "4"])).toBe(3);
		});

		it("supports custom default page", () => {
			expect(parsePageParam("-5", 2)).toBe(2);
		});
	});

	describe("parseLimitParam", () => {
		it("falls back to default limit on missing, non-positive, or fractional input", () => {
			expect(parseLimitParam(undefined, 15)).toBe(15);
			expect(parseLimitParam("", 15)).toBe(15);
			expect(parseLimitParam("0", 15)).toBe(15);
			expect(parseLimitParam("-5", 15)).toBe(15);
			expect(parseLimitParam("2.5", 15)).toBe(15);
			expect(parseLimitParam("foo", 15)).toBe(15);
		});

		it("parses valid positive integer limits", () => {
			expect(parseLimitParam("10", 15)).toBe(10);
			expect(parseLimitParam("25", 15)).toBe(25);
			expect(parseLimitParam(["20", "30"], 15)).toBe(20);
		});

		it("caps oversized limits to maxLimit", () => {
			expect(parseLimitParam("500", 15, 100)).toBe(100);
			expect(parseLimitParam("100", 15, 100)).toBe(100);
		});
	});
});
