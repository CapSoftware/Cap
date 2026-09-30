import { describe, expect, it } from "vitest";
import {
	currencyForCountry,
	currencySymbol,
	formatAmount,
	SUPPORTED_CURRENCIES,
} from "@/utils/currency";

describe("currencyForCountry", () => {
	it("maps the UK and crown dependencies to GBP", () => {
		for (const country of ["GB", "IM", "JE", "GG"]) {
			expect(currencyForCountry(country)).toBe("gbp");
		}
	});

	it("maps eurozone countries and territories to EUR", () => {
		for (const country of ["DE", "FR", "IE", "NL", "GF", "YT", "XK"]) {
			expect(currencyForCountry(country)).toBe("eur");
		}
	});

	it("falls back to USD for non-euro EU countries", () => {
		for (const country of ["SE", "PL", "DK", "CZ", "HU", "NO", "CH"]) {
			expect(currencyForCountry(country)).toBe("usd");
		}
	});

	it("falls back to USD for the rest of the world", () => {
		for (const country of ["US", "CA", "AU", "IN", "BR", "JP"]) {
			expect(currencyForCountry(country)).toBe("usd");
		}
	});

	it("falls back to USD when the country is missing or empty", () => {
		expect(currencyForCountry(null)).toBe("usd");
		expect(currencyForCountry(undefined)).toBe("usd");
		expect(currencyForCountry("")).toBe("usd");
	});

	it("normalizes casing and surrounding whitespace", () => {
		expect(currencyForCountry("gb")).toBe("gbp");
		expect(currencyForCountry(" de ")).toBe("eur");
	});

	it("only ever returns a supported currency", () => {
		for (const country of ["GB", "DE", "US", "ZZ", null]) {
			expect(SUPPORTED_CURRENCIES).toContain(currencyForCountry(country));
		}
	});
});

describe("currencySymbol", () => {
	it("returns the symbol for each supported currency", () => {
		expect(currencySymbol("usd")).toBe("$");
		expect(currencySymbol("gbp")).toBe("£");
		expect(currencySymbol("eur")).toBe("€");
	});

	it("accepts uppercase codes", () => {
		expect(currencySymbol("GBP")).toBe("£");
	});

	it("falls back to an uppercase code prefix for other currencies", () => {
		expect(currencySymbol("aud")).toBe("AUD ");
		expect(currencySymbol("jpy")).toBe("JPY ");
	});
});

describe("formatAmount", () => {
	it("formats supported currencies with their symbol", () => {
		expect(formatAmount(12, "usd")).toBe("$12.00");
		expect(formatAmount(12, "gbp")).toBe("£12.00");
		expect(formatAmount(12, "eur")).toBe("€12.00");
	});

	it("keeps parity pricing identical apart from the symbol", () => {
		const amounts = SUPPORTED_CURRENCIES.map((currency) =>
			formatAmount(8.16, currency).replace(/^\D+/, ""),
		);
		expect(new Set(amounts)).toEqual(new Set(["8.16"]));
	});

	it("formats currencies outside the supported set", () => {
		expect(formatAmount(12, "aud")).toContain("12.00");
	});

	it("falls back without throwing on an invalid currency code", () => {
		expect(formatAmount(12, "notacurrency")).toBe("NOTACURRENCY 12.00");
	});
});
