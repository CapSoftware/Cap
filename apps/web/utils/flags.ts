import { isUserOnProPlan } from "@cap/utils";

export interface FeatureFlagUser {
  email: string;
  stripeSubscriptionStatus?: string | null;
}

export function isAiUiEnabled(user: FeatureFlagUser): boolean {
  if (!user.email) {
    return false;
  }

  const allowedDomains = ["@cap.so", "@mcilroy.co"];
  return allowedDomains.some(domain => 
    user.email.includes(domain)
  );
}

export function isAiGenerationEnabled(user: FeatureFlagUser): boolean {
  if (!user.email) {
    return false;
  }

  const allowedDomains = ["@cap.so", "@mcilroy.co"];
  const hasAllowedEmail = allowedDomains.some(domain => 
    user.email.includes(domain)
  );

  const isProUser = isUserOnProPlan({
    subscriptionStatus: user.stripeSubscriptionStatus || null,
  });

  return hasAllowedEmail && isProUser;
} 