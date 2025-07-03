import { isUserOnProPlan } from "@cap/utils";

export interface FeatureFlagUser {
  email: string;
  stripeSubscriptionStatus?: string | null;
}

export async function isAiGenerationEnabled(user: FeatureFlagUser): Promise<boolean> {
  return isUserOnProPlan({
    subscriptionStatus: user.stripeSubscriptionStatus || null,
  });
} 