import { describe, expect, it } from "vitest";
import {
	DEFAULT_DEVELOPER_API_LIMIT,
	MAX_DEVELOPER_API_LIMIT,
	MAX_DEVELOPER_API_OFFSET,
	parseDeveloperVideosPagination,
} from "../../lib/developer-pagination";

describe("parseDeveloperVideosPagination (#3568)", () => {
	it("returns default values on missing or empty parameters", () => {
		expect(parseDeveloperVideosPagination(undefined, undefined)).toEqual({
			limit: DEFAULT_DEVELOPER_API_LIMIT,
			offset: 0,
		});
		expect(parseDeveloperVideosPagination("", "")).toEqual({
			limit: DEFAULT_DEVELOPER_API_LIMIT,
			offset: 0,
		});
	});

	it("parses valid positive integer limit and offset", () => {
		expect(parseDeveloperVideosPagination("5", "10")).toEqual({
			limit: 5,
			offset: 10,
		});
		expect(parseDeveloperVideosPagination("100", "0")).toEqual({
			limit: 100,
			offset: 0,
		});
	});

	it("floors fractional numbers to prevent SQL syntax errors", () => {
		expect(parseDeveloperVideosPagination("5.5", "2.5")).toEqual({
			limit: 5,
			offset: 2,
		});
		expect(parseDeveloperVideosPagination("10.9", "0.8")).toEqual({
			limit: 10,
			offset: 0,
		});
	});

	it("falls back to defaults for non-positive or non-numeric inputs", () => {
		expect(parseDeveloperVideosPagination("0", "-5")).toEqual({
			limit: DEFAULT_DEVELOPER_API_LIMIT,
			offset: 0,
		});
		expect(parseDeveloperVideosPagination("-1", "invalid")).toEqual({
			limit: DEFAULT_DEVELOPER_API_LIMIT,
			offset: 0,
		});
		expect(parseDeveloperVideosPagination("xyz", "NaN")).toEqual({
			limit: DEFAULT_DEVELOPER_API_LIMIT,
			offset: 0,
		});
	});

	it("caps limit to MAX_DEVELOPER_API_LIMIT and bounds oversized offsets", () => {
		expect(parseDeveloperVideosPagination("500", "99999999999999999999")).toEqual({
			limit: MAX_DEVELOPER_API_LIMIT,
			offset: MAX_DEVELOPER_API_OFFSET,
		});
	});
});
