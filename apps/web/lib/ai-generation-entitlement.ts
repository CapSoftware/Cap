import { hasProSubscription, type ProSubscriptionUser } from "./pro-subscription";

export type AiGenerationEntitlementUser = ProSubscriptionUser;

export const isAiGenerationEnabledForUser = (
	user?: AiGenerationEntitlementUser | null,
) => hasProSubscription(user);
