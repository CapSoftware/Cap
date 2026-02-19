import { isEmailAllowedByRestriction } from "@cap/utils";
import { describe, expect, it } from "vitest";

describe("isEmailAllowedByRestriction", () => {
	describe("domain matching", () => {
		it("allows email matching a single domain", () => {
			expect(
				isEmailAllowedByRestriction("alice@company.com", "company.com"),
			).toBe(true);
		});

		it("rejects email not matching the domain", () => {
			expect(
				isEmailAllowedByRestriction("alice@other.com", "company.com"),
			).toBe(false);
		});

		it("rejects subdomain when only parent domain is allowed", () => {
			expect(
				isEmailAllowedByRestriction("alice@sub.company.com", "company.com"),
			).toBe(false);
		});

		it("is case insensitive for both email and domain", () => {
			expect(
				isEmailAllowedByRestriction("Alice@Company.COM", "company.com"),
			).toBe(true);
			expect(
				isEmailAllowedByRestriction("alice@company.com", "Company.COM"),
			).toBe(true);
		});
	});

	describe("specific email matching", () => {
		it("allows an exact email match", () => {
			expect(
				isEmailAllowedByRestriction("bob@gmail.com", "bob@gmail.com"),
			).toBe(true);
		});

		it("rejects a different email", () => {
			expect(
				isEmailAllowedByRestriction("alice@gmail.com", "bob@gmail.com"),
			).toBe(false);
		});

		it("is case insensitive for specific emails", () => {
			expect(
				isEmailAllowedByRestriction("Bob@Gmail.COM", "bob@gmail.com"),
			).toBe(true);
		});
	});

	describe("comma-separated entries", () => {
		it("allows email matching any of multiple domains", () => {
			const restriction = "company.com, partner.org";
			expect(
				isEmailAllowedByRestriction("alice@company.com", restriction),
			).toBe(true);
			expect(isEmailAllowedByRestriction("bob@partner.org", restriction)).toBe(
				true,
			);
		});

		it("rejects email not matching any entry", () => {
			const restriction = "company.com, partner.org";
			expect(isEmailAllowedByRestriction("alice@other.com", restriction)).toBe(
				false,
			);
		});

		it("supports mix of domains and specific emails", () => {
			const restriction = "company.com, bob@gmail.com, partner.org";
			expect(
				isEmailAllowedByRestriction("alice@company.com", restriction),
			).toBe(true);
			expect(isEmailAllowedByRestriction("bob@gmail.com", restriction)).toBe(
				true,
			);
			expect(
				isEmailAllowedByRestriction("charlie@partner.org", restriction),
			).toBe(true);
			expect(isEmailAllowedByRestriction("alice@gmail.com", restriction)).toBe(
				false,
			);
		});

		it("handles extra whitespace around entries", () => {
			const restriction = " company.com ,  bob@gmail.com , partner.org ";
			expect(
				isEmailAllowedByRestriction("alice@company.com", restriction),
			).toBe(true);
			expect(isEmailAllowedByRestriction("bob@gmail.com", restriction)).toBe(
				true,
			);
		});

		it("handles trailing comma", () => {
			expect(
				isEmailAllowedByRestriction("alice@company.com", "company.com,"),
			).toBe(true);
		});

		it("handles empty entries between commas", () => {
			expect(
				isEmailAllowedByRestriction(
					"alice@company.com",
					"company.com,,partner.org",
				),
			).toBe(true);
			expect(
				isEmailAllowedByRestriction(
					"bob@partner.org",
					"company.com,,partner.org",
				),
			).toBe(true);
		});
	});

	describe("edge cases", () => {
		it("allows any email when restriction is empty string", () => {
			expect(isEmailAllowedByRestriction("anyone@anything.com", "")).toBe(true);
		});

		it("allows any email when restriction is only whitespace/commas", () => {
			expect(isEmailAllowedByRestriction("anyone@anything.com", " , , ")).toBe(
				true,
			);
		});

		it("does not partial-match domain names", () => {
			expect(
				isEmailAllowedByRestriction("alice@notcompany.com", "company.com"),
			).toBe(false);
		});

		it("does not match domain entry as email suffix without @", () => {
			expect(
				isEmailAllowedByRestriction("company.com@evil.com", "company.com"),
			).toBe(false);
		});
	});
});
