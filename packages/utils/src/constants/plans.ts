import { buildEnv, NODE_ENV } from "@cap/env";

const planIds = {
	development: {
		yearly: "price_1Q3esrFJxA1XpeSsFwp486RN",
		monthly: "price_1P9C1DFJxA1XpeSsTwwuddnq",
	},
	production: {
		yearly: "price_1S2al7FJxA1XpeSsJCI5Z2UD",
		monthly: "price_1S2akxFJxA1XpeSsfoAUUbpJ",
	},
};

export const getProPlanId = (billingCycle: "yearly" | "monthly") => {
	const value = NODE_ENV;
	const environment = value === "development" ? "development" : "production";

	return planIds[environment]?.[billingCycle] || "";
};

export const userIsPro = (
	user?: {
		stripeSubscriptionStatus?: string | null;
		thirdPartyStripeSubscriptionId?: string | null;
	} | null,
) => {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;

	if (!user) return false;

	const { stripeSubscriptionStatus, thirdPartyStripeSubscriptionId } = user;

	// Check for third-party subscription first
	if (thirdPartyStripeSubscriptionId) {
		return true;
	}

	// Then check regular subscription status
	return (
		stripeSubscriptionStatus === "active" ||
		stripeSubscriptionStatus === "trialing" ||
		stripeSubscriptionStatus === "complete" ||
		stripeSubscriptionStatus === "paid"
	);
};
