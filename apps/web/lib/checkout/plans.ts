import { STRIPE_PLAN_IDS } from "@cap/utils";
import { MAX_CHECKOUT_QUANTITY } from "@/lib/checkout-quantity";

export type CheckoutPlan = "monthly" | "yearly";
export type CheckoutEnvironment = keyof typeof STRIPE_PLAN_IDS;

export const CHECKOUT_PLANS: readonly CheckoutPlan[] = ["monthly", "yearly"];

export const isCheckoutPlan = (value: unknown): value is CheckoutPlan =>
	value === "monthly" || value === "yearly";

export const planPriceId = (
	plan: CheckoutPlan,
	environment: CheckoutEnvironment,
): string => STRIPE_PLAN_IDS[environment][plan];

export const planForPriceId = (
	priceId: string | null | undefined,
	environment: CheckoutEnvironment,
): CheckoutPlan | null =>
	CHECKOUT_PLANS.find((plan) => planPriceId(plan, environment) === priceId) ??
	null;

export const parseCheckoutSeats = (value: unknown): number => {
	const seats = typeof value === "string" ? Number(value) : value;
	return typeof seats === "number" &&
		Number.isInteger(seats) &&
		seats >= 1 &&
		seats <= MAX_CHECKOUT_QUANTITY
		? seats
		: 1;
};

export const checkoutPath = ({
	plan,
	seats,
	onboarding,
}: {
	plan: CheckoutPlan;
	seats: number;
	onboarding?: boolean;
}): string => {
	const params = new URLSearchParams({ plan, seats: String(seats) });
	if (onboarding) params.set("onboarding", "1");
	return `/checkout?${params.toString()}`;
};

// Stripe only presents a currency when every plan price carries it, otherwise
// switching between monthly and yearly mid-checkout would be rejected.
export const pickCheckoutCurrency = (
	preferred: string,
	supportedByPlan: ReadonlyArray<ReadonlySet<string>>,
): string =>
	supportedByPlan.every((currencies) => currencies.has(preferred))
		? preferred
		: "usd";

export const sessionIdFromClientSecret = (
	clientSecret: string,
): string | null => {
	const [sessionId] = clientSecret.split("_secret_");
	return sessionId && sessionId !== clientSecret && sessionId.startsWith("cs_")
		? sessionId
		: null;
};
