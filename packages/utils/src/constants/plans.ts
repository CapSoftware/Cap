import { buildEnv } from "@cap/env";

export const STRIPE_PLAN_IDS = {
	development: {
		yearly: "price_1Q3esrFJxA1XpeSsFwp486RN",
		monthly: "price_1P9C1DFJxA1XpeSsTwwuddnq",
	},
	production: {
		yearly: "price_1S2al7FJxA1XpeSsJCI5Z2UD",
		monthly: "price_1S2akxFJxA1XpeSsfoAUUbpJ",
	},
};

export const isActiveSubscription = (status?: string | null): boolean => {
	return (
		status === "active" ||
		status === "trialing" ||
		status === "complete" ||
		status === "paid"
	);
};

export const userIsPro = (
	user?: {
		stripeSubscriptionStatus?: string | null;
		thirdPartyStripeSubscriptionId?: string | null;
	} | null,
) => {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;

	if (!user) return false;

	const { stripeSubscriptionStatus, thirdPartyStripeSubscriptionId } = user;

	if (thirdPartyStripeSubscriptionId) {
		return true;
	}

	return isActiveSubscription(stripeSubscriptionStatus);
};

export const orgIsPro = (
	org?: {
		stripeSubscriptionStatus?: string | null;
		paidSeats?: number | null;
	} | null,
) => {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;

	if (!org) return false;

	return isActiveSubscription(org.stripeSubscriptionStatus);
};

export const memberHasPaidSeat = (
	member?: {
		seatType?: string | null;
	} | null,
	org?: {
		stripeSubscriptionStatus?: string | null;
	} | null,
) => {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true;

	if (!member || !org) return false;

	return (
		member.seatType === "paid" &&
		isActiveSubscription(org.stripeSubscriptionStatus)
	);
};
