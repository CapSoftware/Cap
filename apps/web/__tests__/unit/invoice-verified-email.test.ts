import { describe, expect, it } from "vitest";
import { hasVerifiedProviderEmail } from "@/lib/billing/verified-email";

function account(claims: Record<string, unknown> = {}) {
	return {
		provider: "google",
		providerAccountId: "example-subject",
		idToken: `header.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", sub: "example-subject", email: "owner@example.com", email_verified: true, ...claims })).toString("base64url")}.signature`,
	};
}
describe("persisted verified provider email", () => {
	it("supports verified Google and Apple accounts with matching email and subject", () => {
		expect(hasVerifiedProviderEmail("OWNER@example.com", account())).toBe(true);
		expect(
			hasVerifiedProviderEmail("owner@example.com", {
				...account({
					iss: "https://appleid.apple.com",
					email_verified: "true",
				}),
				provider: "apple",
			}),
		).toBe(true);
	});
	it.each([
		{ email_verified: false },
		{ email_verified: "false" },
		{ email: "other@example.com" },
		{ sub: "other" },
		{ iss: "https://evil.test" },
	])("rejects mismatched or unverified claims: %j", (claims) => {
		expect(hasVerifiedProviderEmail("owner@example.com", account(claims))).toBe(
			false,
		);
	});
	it.each([null, "bad", "header.not-json.signature"])(
		"rejects unavailable or corrupt tokens",
		(idToken) => {
			expect(
				hasVerifiedProviderEmail("owner@example.com", {
					...account(),
					idToken,
				}),
			).toBe(false);
		},
	);
});
