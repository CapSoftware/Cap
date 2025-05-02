export declare const getProPlanId: (billingCycle: "yearly" | "monthly") => string;
export declare const isUserOnProPlan: ({ subscriptionStatus, }: {
    subscriptionStatus: string | null;
}) => boolean;
