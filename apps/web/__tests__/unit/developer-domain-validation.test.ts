import { describe, expect, it } from "vitest";
import { normalizeAllowedOrigin } from "@/lib/infra-domain";

const origin = (input: string) => {
	const result = normalizeAllowedOrigin(input);
	return result.ok ? result.origin : null;
};

describe("normalizeAllowedOrigin", () => {
	describe("origins that are stored as typed", () => {
		const unchanged = [
			"https://example.com",
			"https://myapp.com",
			"http://localhost:3000",
			"http://localhost",
			"https://sub.domain.example.com",
			"https://api.my-site.io",
			"https://192.168.1.1",
			"https://192.168.1.1:8080",
			"https://my-app.vercel.app",
			"https://a.b.c.d.e.com",
			"https://0.0.0.0:3000",
			"http://devbox:8080",
		];

		for (const value of unchanged) {
			it(`keeps ${value}`, () => {
				expect(origin(value)).toBe(value);
			});
		}
	});

	describe("input that is reduced to the origin a browser sends", () => {
		const reduced: [string, string][] = [
			["myshop.com", "https://myshop.com"],
			["  MyShop.com  ", "https://myshop.com"],
			["www.myshop.com/", "https://www.myshop.com"],
			["myshop.com/products?id=1", "https://myshop.com"],
			["myshop.com:8443", "https://myshop.com:8443"],
			["localhost:3000", "http://localhost:3000"],
			["localhost", "http://localhost"],
			["127.0.0.1:5173", "http://127.0.0.1:5173"],
			["https://EXAMPLE.COM", "https://example.com"],
			["https://example.com/", "https://example.com"],
			["https://example.com/some/path?x=1", "https://example.com"],
			["https://example.com#hash", "https://example.com"],
			["https://example.com:443", "https://example.com"],
			["http://example.com:80", "http://example.com"],
			["http://[::1]:3000", "http://[::1]:3000"],
		];

		for (const [input, expected] of reduced) {
			it(`turns ${input.trim()} into ${expected}`, () => {
				expect(origin(input)).toBe(expected);
			});
		}
	});

	describe("input that is refused with a plain message", () => {
		const refused: [string, string][] = [
			["", "empty"],
			["   ", "only spaces"],
			["not a domain", "spaces in the host"],
			["just-hostname", "a bare word"],
			["ftp://example.com", "wrong protocol"],
			["https://", "no host"],
			["https://example.com:abc", "non-numeric port"],
			["https://exam ple.com", "space in the host"],
			["javascript:alert(1)", "script URL"],
			["data:text/html,<script>alert(1)</script>", "data URL"],
			["https://user:pass@example.com", "credentials"],
			["*.myshop.com", "wildcard"],
			["https://*.myshop.com", "wildcard with a scheme"],
			["https://-bad-.com", "label starting with a hyphen"],
			[`https://${"a".repeat(260)}.com`, "too long to store"],
		];

		for (const [input, reason] of refused) {
			it(`refuses ${input.slice(0, 40) || "(empty)"}: ${reason}`, () => {
				const result = normalizeAllowedOrigin(input);
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message.length).toBeGreaterThan(10);
					expect(result.message).not.toMatch(/error|invalid url/i);
				}
			});
		}
	});

	it("explains wildcards and protocols specifically", () => {
		expect(normalizeAllowedOrigin("*.myshop.com")).toEqual({
			ok: false,
			message: "Wildcards are not supported. Add each subdomain on its own.",
		});
		expect(normalizeAllowedOrigin("ftp://example.com")).toMatchObject({
			ok: false,
			message: expect.stringContaining("http and https"),
		});
	});
});
