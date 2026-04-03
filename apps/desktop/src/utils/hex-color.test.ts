import { describe, expect, it } from "vitest";
import {
	getHexColorDigitCount,
	hexToRgb,
	normalizeHexColor,
	normalizeOpaqueHexColor,
} from "./hex-color";

describe("hex-color", () => {
	it("normalizes shorthand values with or without a hash", () => {
		expect(normalizeHexColor("fff")).toBe("#FFFFFF");
		expect(normalizeHexColor("#ddd")).toBe("#DDDDDD");
		expect(normalizeOpaqueHexColor("abc")).toBe("#AABBCC");
	});

	it("normalizes full-length values", () => {
		expect(normalizeHexColor("123456")).toBe("#123456");
		expect(normalizeHexColor("#89abcd")).toBe("#89ABCD");
		expect(normalizeHexColor("abcd")).toBe("#AABBCCDD");
	});

	it("reports the entered hex digit count", () => {
		expect(getHexColorDigitCount("fff")).toBe(3);
		expect(getHexColorDigitCount("#123456")).toBe(6);
		expect(getHexColorDigitCount("12345678")).toBe(8);
		expect(getHexColorDigitCount("rgba(0,0,0,1)")).toBe(0);
	});

	it("parses shorthand and alpha values into rgba tuples", () => {
		expect(hexToRgb("fff")).toEqual([255, 255, 255, 255]);
		expect(hexToRgb("#1234")).toEqual([17, 34, 51, 68]);
		expect(hexToRgb("#12345678")).toEqual([18, 52, 86, 120]);
	});

	it("rejects invalid values", () => {
		expect(normalizeHexColor("")).toBeNull();
		expect(normalizeHexColor("12")).toBeNull();
		expect(normalizeHexColor("zzzzzz")).toBeNull();
		expect(normalizeOpaqueHexColor("#12345678")).toBeNull();
		expect(hexToRgb("rgba(0,0,0,1)")).toBeNull();
	});
});
