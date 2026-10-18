import { buildEnv } from "@cap/env";

export type AiGenerationEntitlementUser = {
	stripeSubscriptionStatus?: string | null;
	thirdPartyStripeSubscriptionId?: string | null;
};

export const isAiGenerationEnabledForUser = (
	user?: AiGenerationEntitlementUser | null,
) => {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;
	if (!user) return false;
	if (user.thirdPartyStripeSubscriptionId) return true;

	// Mirrors userIsPro in @cap/utils: past_due keeps entitlement during
	// Stripe's dunning window.
	return (
		user.stripeSubscriptionStatus === "active" ||
		user.stripeSubscriptionStatus === "trialing" ||
		user.stripeSubscriptionStatus === "complete" ||
		user.stripeSubscriptionStatus === "paid" ||
		user.stripeSubscriptionStatus === "past_due"
	);
};
