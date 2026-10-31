import { buildEnv } from "@cap/env";

export type AiGenerationEntitlementUser = {
	stripeSubscriptionStatus?: string | null;
	thirdPartyStripeSubscriptionId?: string | null;
};

// Mirrors userIsPro in @cap/utils: past_due keeps entitlement during
// Stripe's dunning window.
export const AI_ENTITLED_SUBSCRIPTION_STATUSES = [
	"active",
	"trialing",
	"complete",
	"paid",
	"past_due",
];

export const isAiGenerationEnabledForUser = (
	user?: AiGenerationEntitlementUser | null,
) => {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;
	if (!user) return false;
	if (user.thirdPartyStripeSubscriptionId) return true;
	return AI_ENTITLED_SUBSCRIPTION_STATUSES.includes(
		user.stripeSubscriptionStatus ?? "",
	);
};
