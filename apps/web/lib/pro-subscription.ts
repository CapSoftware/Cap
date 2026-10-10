import { buildEnv } from "@cap/env";

export type ProSubscriptionUser = {
	stripeSubscriptionStatus?: string | null;
	thirdPartyStripeSubscriptionId?: string | null;
};

// Mirrors userIsPro in @cap/utils, which workflow code cannot import: past_due
// keeps Pro during Stripe's dunning window.
export const hasProSubscription = (user?: ProSubscriptionUser | null) => {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;
	if (!user) return false;
	if (user.thirdPartyStripeSubscriptionId) return true;

	return (
		user.stripeSubscriptionStatus === "active" ||
		user.stripeSubscriptionStatus === "trialing" ||
		user.stripeSubscriptionStatus === "complete" ||
		user.stripeSubscriptionStatus === "paid" ||
		user.stripeSubscriptionStatus === "past_due"
	);
};
