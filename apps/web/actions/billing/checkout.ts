"use server";

import { timingSafeEqual } from "node:crypto";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { headers } from "next/headers";
import { ensureStripeCustomerId } from "@/lib/checkout/customer";
import { customCheckoutEnabled } from "@/lib/checkout/enabled";
import {
	CHECKOUT_PLANS,
	type CheckoutEnvironment,
	type CheckoutPlan,
	isCheckoutPlan,
	parseCheckoutSeats,
	pickCheckoutCurrency,
	planForPriceId,
	planPriceId,
	sessionIdFromClientSecret,
} from "@/lib/checkout/plans";
import { checkoutStripe } from "@/lib/checkout/stripe";
import { MAX_CHECKOUT_QUANTITY } from "@/lib/checkout-quantity";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { trackServerEvent } from "@/lib/server-analytics";
import { visitorCountry } from "@/lib/visitor-country";
import { currencyForCountry } from "@/utils/currency";

const INTEGRATION_IDENTIFIER = "cap_pro_checkout_rqmvbkzt";
const PRICE_CURRENCY_TTL_MS = 10 * 60 * 1000;

export type CreateCheckoutResult =
	| { ok: true; clientSecret: string }
	| {
			ok: false;
			reason: "already_pro" | "rate_limited" | "unavailable";
	  };

export type UpdateCheckoutResult = { ok: true } | { ok: false };

const checkoutEnvironment = (): CheckoutEnvironment =>
	serverEnv().VERCEL_ENV === "production" ? "production" : "development";

let priceCurrencies:
	| { expiresAt: number; byPlan: Map<CheckoutPlan, Set<string>> }
	| undefined;

async function planCurrencies(environment: CheckoutEnvironment) {
	if (priceCurrencies && priceCurrencies.expiresAt > Date.now()) {
		return priceCurrencies.byPlan;
	}

	const byPlan = new Map<CheckoutPlan, Set<string>>();
	await Promise.all(
		CHECKOUT_PLANS.map(async (plan) => {
			const price = await checkoutStripe().prices.retrieve(
				planPriceId(plan, environment),
				{ expand: ["currency_options"] },
			);
			byPlan.set(
				plan,
				new Set([price.currency, ...Object.keys(price.currency_options ?? {})]),
			);
		}),
	);
	priceCurrencies = { expiresAt: Date.now() + PRICE_CURRENCY_TTL_MS, byPlan };
	return byPlan;
}

export async function createProCheckout(input: {
	plan: string;
	seats: number;
	onboarding: boolean;
}): Promise<CreateCheckoutResult> {
	if (!customCheckoutEnabled()) return { ok: false, reason: "unavailable" };

	const plan: CheckoutPlan = isCheckoutPlan(input.plan)
		? input.plan
		: "monthly";
	const seats = parseCheckoutSeats(input.seats);
	const onboarding = input.onboarding === true;
	const environment = checkoutEnvironment();
	const requestHeaders = await headers();
	const user = await getCurrentUser();

	if (user && userIsPro(user)) return { ok: false, reason: "already_pro" };
	if (
		!user &&
		(await isRateLimited(RATE_LIMIT_IDS.GUEST_CHECKOUT, {
			headers: requestHeaders,
		}))
	) {
		return { ok: false, reason: "rate_limited" };
	}

	try {
		const [customerId, currencies] = await Promise.all([
			user ? ensureStripeCustomerId(user) : Promise.resolve(null),
			planCurrencies(environment),
		]);
		const currency = pickCheckoutCurrency(
			currencyForCountry(
				visitorCountry(requestHeaders.get("x-vercel-ip-country")),
			),
			CHECKOUT_PLANS.map((p) => currencies.get(p) ?? new Set<string>()),
		);

		const session = await checkoutStripe().checkout.sessions.create({
			mode: "subscription",
			ui_mode: "elements",
			line_items: [
				{
					price: planPriceId(plan, environment),
					quantity: seats,
					adjustable_quantity: {
						enabled: true,
						minimum: 1,
						maximum: MAX_CHECKOUT_QUANTITY,
					},
				},
			],
			currency,
			return_url: `${serverEnv().WEB_URL}/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
			allow_promotion_codes: true,
			billing_address_collection: "auto",
			name_collection: { business: { enabled: true, optional: true } },
			tax_id_collection: { enabled: true },
			integration_identifier: INTEGRATION_IDENTIFIER,
			// Newer API versions default subscriptions to flexible billing, which
			// the 2023-10-16 seat management (upcoming invoice previews) rejects.
			subscription_data: { billing_mode: { type: "classic" } },
			...(customerId
				? {
						customer: customerId,
						customer_update: { name: "auto", address: "auto" },
					}
				: {}),
			metadata: {
				platform: "web",
				checkoutUi: "elements",
				isOnBoarding: onboarding ? "true" : "false",
				...(user ? { dubCustomerId: user.id } : { guestCheckout: "true" }),
			},
		});

		if (!session.client_secret) {
			console.error("Checkout session created without a client secret", {
				sessionId: session.id,
			});
			return { ok: false, reason: "unavailable" };
		}

		trackServerEvent(
			user ? user.id : `guest-${session.id}`,
			user ? "checkout_started" : "guest_checkout_started",
			{
				price_id: planPriceId(plan, environment),
				quantity: seats,
				platform: "web",
				checkout_ui: "elements",
				currency,
				session_id: session.id,
			},
		);

		return { ok: true, clientSecret: session.client_secret };
	} catch (error) {
		console.error("Failed to create Cap Pro checkout session:", error);
		return { ok: false, reason: "unavailable" };
	}
}

const secretsMatch = (a: string, b: string) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};

export async function changeProCheckoutPlan(input: {
	clientSecret: string;
	plan: string;
}): Promise<UpdateCheckoutResult> {
	if (!customCheckoutEnabled() || !isCheckoutPlan(input.plan)) {
		return { ok: false };
	}
	const sessionId =
		typeof input.clientSecret === "string"
			? sessionIdFromClientSecret(input.clientSecret)
			: null;
	if (!sessionId) return { ok: false };

	const environment = checkoutEnvironment();

	try {
		const session = await checkoutStripe().checkout.sessions.retrieve(
			sessionId,
			{ expand: ["line_items"] },
		);
		const lineItem = session.line_items?.data[0];

		// The client secret is the only credential a guest holds for their
		// session, so it is what authorizes changing the plan on it.
		if (
			!session.client_secret ||
			!secretsMatch(session.client_secret, input.clientSecret) ||
			session.status !== "open" ||
			session.metadata?.checkoutUi !== "elements" ||
			session.line_items?.data.length !== 1 ||
			!lineItem ||
			!planForPriceId(lineItem.price?.id, environment)
		) {
			return { ok: false };
		}

		await checkoutStripe().checkout.sessions.update(sessionId, {
			line_items: [
				{
					id: lineItem.id,
					price: planPriceId(input.plan, environment),
					quantity: lineItem.quantity ?? 1,
				},
			],
		});

		return { ok: true };
	} catch (error) {
		console.error("Failed to change Cap Pro checkout plan:", error);
		return { ok: false };
	}
}
