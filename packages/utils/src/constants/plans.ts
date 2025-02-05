import { NODE_ENV } from "@cap/env";

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
  const value = NODE_ENV;
  const environment = value === "development" ? "development" : "production";

  return planIds[environment]?.[billingCycle] || "";
};

export const isUserOnProPlan = ({
  subscriptionStatus,
}: {
  subscriptionStatus: string;
}) => {
  if (
    subscriptionStatus === "active" ||
    subscriptionStatus === "trialing" ||
    subscriptionStatus === "complete" ||
    subscriptionStatus === "paid"
  ) {
    return true;
  }

  return false;
};
