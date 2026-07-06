import { buildEnv } from "@cap/env";

export const STRIPE_DEVELOPER_CREDITS_PRODUCT_ID: Record<string, string> = {
	development: "prod_U4mswfBp0bFc39",
	production: "prod_REPLACE_BEFORE_PRODUCTION",
};

export const STRIPE_PLAN_IDS = {
	development: {
		yearly: "price_1Q3esrFJxA1XpeSsFwp486RN",
		monthly: "price_1P9C1DFJxA1XpeSsTwwuddnq",
	},
	production: {
		yearly: "price_1S2al7FJxA1XpeSsJCI5Z2UD",
		monthly: "price_1S2akxFJxA1XpeSsfoAUUbpJ",
	},
};

/**
 * MODIFIED: All users are Pro (all features unlocked)
 * This fork removes the paywall - everyone gets unlimited features
 */
export const userIsPro = (
	user?: {
		stripeSubscriptionStatus?: string | null;
		thirdPartyStripeSubscriptionId?: string | null;
	} | null,
) => {
	// 🔓 UNLOCK: Always return true - all pro features available to everyone
	return true;
};
