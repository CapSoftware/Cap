import { commands } from "./tauri";

const planIds = {
  development: {
    yearly: "price_1Q3esrFJxA1XpeSsFwp486RN",
    monthly: "price_1P9C1DFJxA1XpeSsTwwuddnq",
  },
  production: {
    yearly: "price_1Q29mcFJxA1XpeSsbti0xJpZ",
    monthly: "price_1OtBMeFJxA1XpeSsfOu2SKp1",
  },
};

export const getProPlanId = (billingCycle: "yearly" | "monthly") => {
  const environment =
    import.meta.env.VITE_ENVIRONMENT === "development"
      ? "development"
      : "production";
  return planIds[environment]?.[billingCycle] || "";
};

export function isUserOnProPlan({ subscriptionStatus }: { subscriptionStatus: string | null }): boolean {
  if (
    subscriptionStatus === "active" ||
    subscriptionStatus === "trialing" ||
    subscriptionStatus === "complete" ||
    subscriptionStatus === "paid"
  ) {
    return true;
  }
  return false;
}

export async function checkIsUpgradedAndUpdate(): Promise<boolean> {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_URL}/api/desktop/plan`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error("Failed to check plan status");
    }

    const data = await response.json();
    return isUserOnProPlan({ subscriptionStatus: data.stripeSubscriptionStatus });
  } catch (error) {
    console.error("Error checking plan status:", error);
    return false;
  }
}

export async function canCreateShareableLink(duration: number | undefined | null): Promise<{ allowed: boolean; reason?: string }> {
  const isUpgraded = await checkIsUpgradedAndUpdate();
  
  if (!isUpgraded && duration && duration > 300) {
    return { 
      allowed: false, 
      reason: "upgrade_required"
    };
  }

  return { allowed: true };
}