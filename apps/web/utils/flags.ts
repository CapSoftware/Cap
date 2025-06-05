import { isUserOnProPlan } from "@cap/utils";
import { getBootstrapData } from "./getBootstrapData";

export interface FeatureFlagUser {
  email: string;
  stripeSubscriptionStatus?: string | null;
}

export async function isAiUiEnabled(user: FeatureFlagUser): Promise<boolean> {
  if (!user.email) {
    return false;
  }

  const bootstrap = await getBootstrapData();

  return bootstrap.allowedEmails.includes(user.email);
}

export async function isAiGenerationEnabled(user: FeatureFlagUser): Promise<boolean> {
  if (!user.email) {
    return false;
  }

  const bootstrap = await getBootstrapData();
  const hasAllowedEmail = bootstrap.allowedEmails.includes(user.email);

  const isProUser = isUserOnProPlan({
    subscriptionStatus: user.stripeSubscriptionStatus || null,
  });

  return hasAllowedEmail && isProUser;
} 