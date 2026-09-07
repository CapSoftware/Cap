import { serverEnv } from "@cap/env";
import { isValidStripePlanPriceId, stripe } from "@cap/utils";
import type { NextRequest } from "next/server";
import { getCheckoutRedirectUrls } from "@/lib/mobile-checkout";
import { trackServerEvent } from "@/lib/server-analytics";

export async function POST(request: NextRequest) {
	console.log("Starting guest checkout process");
	const { priceId, quantity, platform } = await request.json();
	const checkoutPlatform = platform === "mobile" ? "mobile" : "web";

	console.log("Received guest checkout request:", { priceId, quantity });

	if (
		!priceId ||
		typeof priceId !== "string" ||
		!isValidStripePlanPriceId(priceId)
	) {
		console.error("Invalid or missing priceId");
		return Response.json({ error: "Invalid priceId" }, { status: 400 });
	}

	const safeQuantity =
		typeof quantity === "number" &&
		Number.isInteger(quantity) &&
		quantity >= 1 &&
		quantity <= 1000
			? quantity
			: 1;

	try {
		console.log("Creating guest checkout session");
		const redirects = getCheckoutRedirectUrls(
			checkoutPlatform,
			serverEnv().WEB_URL,
		);
		const checkoutSession = await stripe().checkout.sessions.create({
			line_items: [{ price: priceId, quantity: safeQuantity }],
			mode: "subscription",
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
					quantity: quantity || 1,
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
