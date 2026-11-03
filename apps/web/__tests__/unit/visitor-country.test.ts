import { afterEach, describe, expect, it, vi } from "vitest";
import { visitorCountry } from "@/lib/visitor-country";
import { currencyForCountry } from "@/utils/currency";

const currencyFor = (header: string | null | undefined) =>
	currencyForCountry(visitorCountry(header));

describe("visitorCountry", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("ignores the header off Vercel, where the client controls it", () => {
		vi.stubEnv("VERCEL", "");
		expect(visitorCountry("GB")).toBeNull();
		expect(currencyFor("GB")).toBe("usd");
		expect(currencyFor("DE")).toBe("usd");
	});

	it("uses Vercel's country code", () => {
		vi.stubEnv("VERCEL", "1");
		expect(visitorCountry("GB")).toBe("GB");
		expect(visitorCountry(" de ")).toBe("DE");
		expect(currencyFor("GB")).toBe("gbp");
		expect(currencyFor("FR")).toBe("eur");
		expect(currencyFor("US")).toBe("usd");
		expect(currencyFor("SE")).toBe("usd");
	});

	it("falls back to usd when the location is missing or malformed", () => {
		vi.stubEnv("VERCEL", "1");
		for (const header of [null, undefined, "", "G", "GBR", "G1", "GB,DE"]) {
			expect(visitorCountry(header)).toBeNull();
			expect(currencyFor(header)).toBe("usd");
		}
		// Unknown or placeholder codes are well formed but map to no region.
		expect(currencyFor("XX")).toBe("usd");
		expect(currencyFor("EU")).toBe("usd");
	});
});
