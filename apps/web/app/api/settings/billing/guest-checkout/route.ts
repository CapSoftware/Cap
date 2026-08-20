import { serverEnv } from "@cap/env";
import { STRIPE_PLAN_IDS, stripe } from "@cap/utils";
import type { NextRequest } from "next/server";
import { getCheckoutRedirectUrls } from "@/lib/mobile-checkout";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { trackServerEvent } from "@/lib/server-analytics";

const MAX_QUANTITY = 100;

/**
 * Prices this unauthenticated endpoint is allowed to sell.
 *
 * Without this the route would mint a Stripe Checkout Session for ANY price id
 * on the account, which includes retired cheaper plans (e.g. the legacy $9/mo
 * and $72/yr tiers) — an informed caller could simply subscribe at a price we
 * no longer offer. Mirrors the ids handed to the client in
 * `app/Layout/PublicPageProviders.tsx`, so it must use the same env condition.
 */
function allowedPriceIds(): Set<string> {
	const plans =
		process.env.VERCEL_ENV === "production"
			? STRIPE_PLAN_IDS.production
			: STRIPE_PLAN_IDS.development;
	return new Set(Object.values(plans));
}

export async function POST(request: NextRequest) {
	const { priceId, quantity, platform } = await request.json();
	const checkoutPlatform = platform === "mobile" ? "mobile" : "web";

	if (!priceId || typeof priceId !== "string") {
		return Response.json({ error: "priceId is required" }, { status: 400 });
	}

	if (!allowedPriceIds().has(priceId)) {
		console.error("Guest checkout rejected: price id not offered", { priceId });
		return Response.json({ error: "Invalid priceId" }, { status: 400 });
	}

	const seats = quantity ?? 1;
	if (
		typeof seats !== "number" ||
		!Number.isInteger(seats) ||
		seats < 1 ||
		seats > MAX_QUANTITY
	) {
		return Response.json(
			{ error: `quantity must be an integer between 1 and ${MAX_QUANTITY}` },
			{ status: 400 },
		);
	}

	// Unauthenticated + calls Stripe on every request, so it is trivially
	// abusable: five burst days in Jul/Aug 2026 created ~4,900 sessions with no
	// customer attached, which also made checkout conversion unmeasurable.
	if (
		await isRateLimited(RATE_LIMIT_IDS.GUEST_CHECKOUT, {
			headers: request.headers,
		})
	) {
		return Response.json({ error: "Too many requests" }, { status: 429 });
	}

	try {
		const redirects = getCheckoutRedirectUrls(
			checkoutPlatform,
			serverEnv().WEB_URL,
		);
		const checkoutSession = await stripe().checkout.sessions.create({
			line_items: [{ price: priceId, quantity: seats }],
			mode: "subscription",
			success_url: redirects.successUrl,
			cancel_url: redirects.cancelUrl,
			allow_promotion_codes: true,
			// Lets `checkout.session.expired` carry a recovery URL so abandoned
			// checkouts can be emailed back to people who already have an account.
			after_expiration: {
				recovery: { enabled: true, allow_promotion_codes: true },
			},
			metadata: {
				platform: checkoutPlatform,
				guestCheckout: "true",
				// Read back on `checkout.session.expired` to tailor the recovery email.
				priceId,
			},
		});

		if (checkoutSession.url) {
			trackServerEvent(
				`guest-${checkoutSession.id}`,
				"guest_checkout_started",
				{
					price_id: priceId,
					quantity: seats,
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
		console.error("Error creating guest checkout session:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
