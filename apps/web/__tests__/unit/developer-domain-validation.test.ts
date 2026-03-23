import { describe, expect, it } from "vitest";

const urlPattern = /^https?:\/\/[a-z0-9.-]+(:[0-9]+)?$/;

function normalizeDomain(input: string): string {
	return input.trim().toLowerCase();
}

describe("developer domain validation regex", () => {
	describe("valid domains", () => {
		const validDomains = [
			"https://example.com",
			"https://myapp.com",
			"http://localhost:3000",
			"http://localhost",
			"https://sub.domain.example.com",
			"https://api.my-site.io",
			"https://192.168.1.1",
			"https://192.168.1.1:8080",
			"http://localhost:8080",
			"https://my-app.vercel.app",
			"https://a.b.c.d.e.com",
			"https://example.com:443",
			"http://example.com:80",
			"https://0.0.0.0:3000",
		];

		for (const domain of validDomains) {
			it(`matches ${domain}`, () => {
				expect(urlPattern.test(domain)).toBe(true);
			});
		}
	});

	describe("invalid domains", () => {
		const invalidDomains: [string, string][] = [
			["example.com", "no protocol"],
			["ftp://example.com", "wrong protocol"],
			["https://example.com/", "trailing slash"],
			["https://example.com/path", "has path"],
			["https://example.com?query=1", "has query"],
			["https://example.com#hash", "has hash"],
			["https://", "no hostname"],
			["https://EXAMPLE.COM", "uppercase"],
			["https://example.com:", "port separator but no port"],
			["https://example.com:abc", "non-numeric port"],
			["https://exam ple.com", "space in hostname"],
			["", "empty string"],
			["javascript:alert(1)", "XSS attempt"],
			["data:text/html,<script>alert(1)</script>", "data URI"],
		];

		for (const [domain, reason] of invalidDomains) {
			it(`rejects ${domain || "(empty string)"} — ${reason}`, () => {
				expect(urlPattern.test(domain)).toBe(false);
			});
		}
	});

	describe("edge case: large port number", () => {
		it("matches https://example.com:99999 since regex only checks for digits", () => {
			expect(urlPattern.test("https://example.com:99999")).toBe(true);
		});
	});
});

describe("domain normalization", () => {
	it("trims whitespace and lowercases the input", () => {
		const raw = " https://Example.COM ";
		const normalized = normalizeDomain(raw);
		expect(normalized).toBe("https://example.com");
	});

	it("produces a value that passes the regex after normalization", () => {
		const raw = " https://Example.COM ";
		const normalized = normalizeDomain(raw);
		expect(urlPattern.test(normalized)).toBe(true);
	});

	it("lowercases mixed-case input before regex test", () => {
		const raw = "https://MyApp.Vercel.App";
		const normalized = normalizeDomain(raw);
		expect(normalized).toBe("https://myapp.vercel.app");
		expect(urlPattern.test(normalized)).toBe(true);
	});

	it("uppercase raw input fails regex directly but passes after normalization", () => {
		const raw = "https://EXAMPLE.COM";
		expect(urlPattern.test(raw)).toBe(false);
		expect(urlPattern.test(normalizeDomain(raw))).toBe(true);
	});
});
