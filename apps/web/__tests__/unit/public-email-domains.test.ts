import { describe, expect, it } from "vitest";
import { sharesInviterCompanyDomain } from "@/lib/public-email-domains";

describe("sharesInviterCompanyDomain", () => {
	it("matches addresses on the inviter's own company domain", () => {
		expect(
			sharesInviterCompanyDomain("Admin@Acme.dev", " teammate@acme.dev "),
		).toBe(true);
	});

	it("does not match other domains or subdomains", () => {
		expect(
			sharesInviterCompanyDomain("admin@acme.dev", "someone@elsewhere.dev"),
		).toBe(false);
		expect(
			sharesInviterCompanyDomain("admin@acme.dev", "someone@eu.acme.dev"),
		).toBe(false);
	});

	it("does not treat public email providers as a shared company", () => {
		expect(
			sharesInviterCompanyDomain("admin@gmail.com", "someone@gmail.com"),
		).toBe(false);
		expect(
			sharesInviterCompanyDomain("admin@outlook.com", "someone@outlook.com"),
		).toBe(false);
	});

	it("does not match without a usable inviter address", () => {
		expect(sharesInviterCompanyDomain(null, "someone@acme.dev")).toBe(false);
		expect(sharesInviterCompanyDomain("admin@", "someone@acme.dev")).toBe(
			false,
		);
		expect(sharesInviterCompanyDomain("admin@acme.dev", "acme.dev")).toBe(
			false,
		);
	});
});
