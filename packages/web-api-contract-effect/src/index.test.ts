import { describe, expect, it } from "vitest";
import { Authentication, User } from "./index";

describe("web API contract effect exports", () => {
	it("constructs immutable user context data", () => {
		const user = new User({
			id: "user_1",
			email: "user@example.com",
			stripeSubscriptionStatus: "active",
			thirdPartyStripeSubscriptionId: null,
			stripeSubscriptionId: "sub_1",
			stripeCustomerId: "cus_1",
		});

		expect(user).toMatchObject({
			id: "user_1",
			email: "user@example.com",
			stripeSubscriptionStatus: "active",
			thirdPartyStripeSubscriptionId: null,
			stripeSubscriptionId: "sub_1",
			stripeCustomerId: "cus_1",
		});
	});

	it("exposes the authentication context tag", () => {
		expect(Authentication.key).toBe("Authentication");
	});
});
