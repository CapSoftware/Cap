import { describe, expect, it } from "vitest";
import { parseDeveloperListParams } from "@/lib/developer-list-params";

const parse = (limit?: string, offset?: string) =>
	parseDeveloperListParams(limit, offset);

describe("parseDeveloperListParams", () => {
	it("keeps the existing defaults and cap", () => {
		expect(parse()).toEqual({ limit: 50, offset: 0 });
		expect(parse("0", "abc")).toEqual({ limit: 50, offset: 0 });
		expect(parse("25", "10")).toEqual({ limit: 25, offset: 10 });
		expect(parse("500")).toEqual({ limit: 100, offset: 0 });
	});

	it("only passes whole numbers MySQL accepts in LIMIT and OFFSET", () => {
		expect(parse("5.5", "2.5")).toEqual({ limit: 5, offset: 2 });
		expect(parse("-1", "-5")).toEqual({ limit: 1, offset: 0 });
		expect(parse("Infinity", "99999999999999999999")).toEqual({
			limit: 100,
			offset: Number.MAX_SAFE_INTEGER,
		});
	});
});
