import { describe, expect, it } from "vitest";
import { parsePageParam } from "@/lib/page-param";

describe("parsePageParam", () => {
	it("keeps positive whole numbers", () => {
		expect(parsePageParam("1")).toBe(1);
		expect(parsePageParam("4")).toBe(4);
		expect(parsePageParam(["3", "9"])).toBe(3);
	});

	it("falls back for values that would produce an invalid offset or limit", () => {
		for (const value of [
			"-1",
			"0",
			"1.5",
			"abc",
			"",
			"1e400",
			undefined,
			null,
		]) {
			expect(parsePageParam(value)).toBe(1);
		}
		expect(parsePageParam("2.5", 15)).toBe(15);
		expect(parsePageParam("-5", 15)).toBe(15);
	});
});
