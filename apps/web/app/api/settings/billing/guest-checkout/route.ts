import { randomUUID } from "node:crypto";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import type { NextRequest } from "next/server";
import { guestCheckoutStartedEvent } from "@/lib/analytics/business-events";
import {
	queueServerProductEvent,
	readAnalyticsAnonymousId,
} from "@/lib/analytics/server";
import { subscriptionCheckoutAnalyticsMetadata } from "@/lib/analytics/stripe-business-events";
import { getCheckoutRedirectUrls } from "@/lib/mobile-checkout";

export async function POST(request: NextRequest) {
	console.log("Starting guest checkout process");
	const { priceId, quantity, platform } = await request.json();
	const checkoutPlatform = platform === "mobile" ? "mobile" : "web";
	const analyticsAnonymousId = readAnalyticsAnonymousId(request);
	const checkoutAnonymousId = analyticsAnonymousId ?? `guest:${randomUUID()}`;

	console.log("Received guest checkout request:", { priceId, quantity });

	if (!priceId) {
		console.error("Missing required priceId");
		return Response.json({ error: "priceId is required" }, { status: 400 });
	}

	try {
		console.log("Creating guest checkout session");
		const analyticsMetadata = subscriptionCheckoutAnalyticsMetadata({
			platform: checkoutPlatform,
			priceId,
			quantity: quantity || 1,
			anonymousId: checkoutAnonymousId,
			isFirstPurchase: true,
			isGuestCheckout: true,
		});
		const redirects = getCheckoutRedirectUrls(
			checkoutPlatform,
			serverEnv().WEB_URL,
		);
		const checkoutSession = await stripe().checkout.sessions.create({
			line_items: [{ price: priceId, quantity: quantity || 1 }],
			mode: "subscription",
			success_url: redirects.successUrl,
			cancel_url: redirects.cancelUrl,
			allow_promotion_codes: true,
			metadata: analyticsMetadata,
			subscription_data: { metadata: analyticsMetadata },
		});

		if (checkoutSession.url) {
			console.log("Successfully created guest checkout session");
			await queueServerProductEvent(
				guestCheckoutStartedEvent({
					checkoutId: checkoutSession.id,
					createdAt: new Date(checkoutSession.created * 1_000),
					anonymousId: checkoutAnonymousId,
					platform: checkoutPlatform,
					priceId,
					quantity: quantity || 1,
				}),
			).catch(() => {
				console.warn(
					"Guest checkout analytics enqueue failed; reconciliation pending",
				);
			});

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
