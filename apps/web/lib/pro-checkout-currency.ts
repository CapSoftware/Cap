import { STRIPE_PLAN_IDS, stripe } from "@cap/utils";
import type Stripe from "stripe";
import {
	isSupportedCurrency,
	SUPPORTED_CURRENCIES,
	type SupportedCurrency,
} from "@/utils/currency";

export type ProCheckoutFlow = "account" | "guest";
export type ProCheckoutPeriod = "monthly" | "yearly";

export class CheckoutCurrencyUnavailable extends Error {
	constructor() {
		super(
			"This currency is unavailable for the selected plan. Choose another currency and try again.",
		);
	}
}

export function proCheckoutPeriod(priceId: string): ProCheckoutPeriod | null {
	const plans =
		process.env.VERCEL_ENV === "production"
			? STRIPE_PLAN_IDS.production
			: STRIPE_PLAN_IDS.development;
	if (priceId === plans.monthly) return "monthly";
	if (priceId === plans.yearly) return "yearly";
	return null;
}

export function proCheckoutStepUrl({
	baseUrl,
	priceId,
	quantity,
	flow,
	isOnBoarding = false,
}: {
	baseUrl: string;
	priceId: string;
	quantity: number;
	flow: ProCheckoutFlow;
	isOnBoarding?: boolean;
}): string | null {
	if (
		!proCheckoutPeriod(priceId) ||
		!Number.isSafeInteger(quantity) ||
		quantity < 1
	)
		return null;
	const url = new URL("/checkout", baseUrl);
	url.searchParams.set("priceId", priceId);
	url.searchParams.set("quantity", String(quantity));
	url.searchParams.set("flow", flow);
	if (isOnBoarding) url.searchParams.set("isOnBoarding", "true");
	return url.toString();
}

export function availableCheckoutCurrencies(
	price: Pick<Stripe.Price, "currency" | "currency_options">,
): SupportedCurrency[] {
	return SUPPORTED_CURRENCIES.filter(
		(currency) =>
			price.currency === currency ||
			Boolean(price.currency_options?.[currency]),
	);
}

export function checkoutSessionCurrency(
	choice: unknown,
	price: Pick<Stripe.Price, "currency" | "currency_options">,
): SupportedCurrency | undefined {
	if (choice === "auto") return undefined;
	if (typeof choice !== "string" || !isSupportedCurrency(choice))
		throw new CheckoutCurrencyUnavailable();
	if (!availableCheckoutCurrencies(price).includes(choice))
		throw new CheckoutCurrencyUnavailable();
	return choice;
}

export async function checkoutCurrencyForChoice(
	priceId: string,
	choice: unknown,
): Promise<SupportedCurrency | undefined> {
	if (choice === "auto") return undefined;
	const price = await stripe().prices.retrieve(priceId, {
		expand: ["currency_options"],
	});
	if (!price.active) throw new CheckoutCurrencyUnavailable();
	return checkoutSessionCurrency(choice, price);
}
