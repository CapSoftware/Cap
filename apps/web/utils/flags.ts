import { userIsPro } from "@inflight/utils";

export interface FeatureFlagUser {
	email: string;
	stripeSubscriptionStatus?: string | null;
}

export async function isAiGenerationEnabled(
	user: FeatureFlagUser,
): Promise<boolean> {
	return userIsPro(user);
}
