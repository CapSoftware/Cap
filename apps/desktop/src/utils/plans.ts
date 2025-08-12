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

export function isUserOnProPlan({
	subscriptionStatus,
}: {
	subscriptionStatus: string | null;
}): boolean {
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
