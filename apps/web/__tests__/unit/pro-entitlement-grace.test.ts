import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
}));

import { userIsPro } from "@cap/utils";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";

describe("Pro entitlement during Stripe dunning window", () => {
	it("keeps Pro while a subscription is past_due", () => {
		expect(userIsPro({ stripeSubscriptionStatus: "past_due" })).toBe(true);
		expect(
			isAiGenerationEnabledForUser({ stripeSubscriptionStatus: "past_due" }),
		).toBe(true);
	});

	it("still grants Pro for the existing entitled statuses", () => {
		for (const status of ["active", "trialing", "complete", "paid"]) {
			expect(userIsPro({ stripeSubscriptionStatus: status })).toBe(true);
		}
	});

	it("drops Pro once Stripe gives up on the subscription", () => {
		for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
			expect(userIsPro({ stripeSubscriptionStatus: status })).toBe(false);
			expect(
				isAiGenerationEnabledForUser({ stripeSubscriptionStatus: status }),
			).toBe(false);
		}
	});

	it("denies missing users and statuses", () => {
		expect(userIsPro(null)).toBe(false);
		expect(userIsPro({ stripeSubscriptionStatus: null })).toBe(false);
	});
});
