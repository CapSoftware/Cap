import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import type { NextRequest } from "next/server";
import { getCheckoutRedirectUrls } from "@/lib/mobile-checkout";
import {
	CheckoutCurrencyUnavailable,
	checkoutCurrencyForChoice,
	proCheckoutPeriod,
	proCheckoutStepUrl,
} from "@/lib/pro-checkout-currency";
import { trackServerEvent } from "@/lib/server-analytics";

export async function POST(request: NextRequest) {
	console.log("Starting guest checkout process");
	const body = (await request.json()) as Record<string, unknown>;
	const { priceId } = body;
	const quantity = body.quantity === undefined ? 1 : Number(body.quantity);
	const platform = body.platform;
	const continueCheckout = body.continueCheckout === true;
	const checkoutPlatform = platform === "mobile" ? "mobile" : "web";

	console.log("Received guest checkout request:", { priceId, quantity });

	if (typeof priceId !== "string" || !priceId) {
		console.error("Missing required priceId");
		return Response.json({ error: "priceId is required" }, { status: 400 });
	}
	if (!Number.isSafeInteger(quantity) || quantity < 1) {
		return Response.json(
			{ error: "Choose at least one user." },
			{ status: 400 },
		);
	}
	const period = proCheckoutPeriod(priceId);
	if (continueCheckout && (checkoutPlatform !== "web" || !period)) {
		return Response.json({ error: "Invalid checkout plan." }, { status: 400 });
	}
	if (period && checkoutPlatform === "web" && !continueCheckout) {
		const url = proCheckoutStepUrl({
			baseUrl: serverEnv().WEB_URL,
			priceId,
			quantity,
			flow: "guest",
		});
		if (!url) return Response.json({ error: true }, { status: 400 });
		return Response.json({ url }, { status: 200 });
	}

	try {
		console.log("Creating guest checkout session");
		const checkoutCurrency = continueCheckout
			? await checkoutCurrencyForChoice(priceId, body.checkoutCurrency)
			: undefined;
		const redirects = getCheckoutRedirectUrls(
			checkoutPlatform,
			serverEnv().WEB_URL,
		);
		const checkoutSession = await stripe().checkout.sessions.create({
			line_items: [{ price: priceId, quantity }],
			mode: "subscription",
			...(checkoutCurrency ? { currency: checkoutCurrency } : {}),
			success_url: redirects.successUrl,
			cancel_url: redirects.cancelUrl,
			allow_promotion_codes: true,
			metadata: {
				platform: checkoutPlatform,
				guestCheckout: "true",
			},
		});

		if (checkoutSession.url) {
			console.log("Successfully created guest checkout session");

			trackServerEvent(
				`guest-${checkoutSession.id}`,
				"guest_checkout_started",
				{
					price_id: priceId,
					quantity,
					platform: checkoutPlatform,
					session_id: checkoutSession.id,
				},
			);

			return Response.json({ url: checkoutSession.url }, { status: 200 });
		}

		console.error("Checkout session created but no URL returned");
		return Response.json(
			{ error: "Failed to create checkout session" },
			{ status: 400 },
		);
	} catch (error) {
		if (error instanceof CheckoutCurrencyUnavailable) {
			return Response.json(
				{ error: true, message: error.message },
				{ status: 400 },
			);
		}
		console.error("Error creating guest checkout session:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
