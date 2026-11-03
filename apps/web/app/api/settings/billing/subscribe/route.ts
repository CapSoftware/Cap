import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { isValidStripePlanPriceId, stripe, userIsPro } from "@cap/utils";
import type { NextRequest } from "next/server";
import { ensureStripeCustomerId } from "@/lib/checkout/customer";
import { customCheckoutEnabled } from "@/lib/checkout/enabled";
import { checkoutPath, planForPriceId } from "@/lib/checkout/plans";
import { parseCheckoutQuantity } from "@/lib/checkout-quantity";
import { trackServerEvent } from "@/lib/server-analytics";

export async function POST(request: NextRequest) {
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	const { priceId, quantity, isOnBoarding, hosted } = await request.json();

	const environment =
		serverEnv().VERCEL_ENV === "production" ? "production" : "development";

	if (
		!priceId ||
		typeof priceId !== "string" ||
		!isValidStripePlanPriceId(priceId, environment)
	) {
		console.error("Invalid or missing priceId");
		return Response.json(
			{ error: true, message: "Invalid priceId" },
			{ status: 400 },
		);
	}

	const safeQuantity = parseCheckoutQuantity(quantity);
	if (safeQuantity === null) {
		console.error("Invalid quantity");
		return Response.json(
			{ error: true, message: "Invalid quantity" },
			{ status: 400 },
		);
	}

	if (!user) {
		console.error("User not found");
		return Response.json({ error: true, auth: false }, { status: 401 });
	}

	const plan = planForPriceId(priceId, environment);
	const inAppCheckout = plan && hosted !== true && customCheckoutEnabled();

	if (userIsPro(user)) {
		if (plan && inAppCheckout) {
			return Response.json(
				{ url: checkoutPath({ plan, seats: safeQuantity }) },
				{ status: 200 },
			);
		}
		console.error("User already has pro plan");
		return Response.json({ error: true, subscription: true }, { status: 400 });
	}

	if (plan && inAppCheckout) {
		return Response.json(
			{
				url: checkoutPath({
					plan,
					seats: safeQuantity,
					onboarding: Boolean(isOnBoarding),
				}),
			},
			{ status: 200 },
		);
	}

	try {
		const customerId = await ensureStripeCustomerId(user);

		const checkoutSession = await stripe().checkout.sessions.create({
			customer: customerId,
			line_items: [{ price: priceId, quantity: safeQuantity }],
			mode: "subscription",
			success_url: isOnBoarding
				? `${serverEnv().WEB_URL}/dashboard/settings/organization?upgrade=true&session_id={CHECKOUT_SESSION_ID}`
				: `${serverEnv().WEB_URL}/dashboard/caps?upgrade=true&session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: isOnBoarding
				? `${serverEnv().WEB_URL}/onboarding`
				: `${serverEnv().WEB_URL}/pricing`,
			allow_promotion_codes: true,
			metadata: {
				platform: "web",
				dubCustomerId: user.id,
				isOnBoarding: isOnBoarding ? "true" : "false",
			},
		});

		if (checkoutSession.url) {
			trackServerEvent(user.id, "checkout_started", {
				price_id: priceId,
				quantity: safeQuantity,
				platform: "web",
			});

			return Response.json({ url: checkoutSession.url }, { status: 200 });
		}

		console.error("Checkout session created but no URL returned");
		return Response.json({ error: true }, { status: 400 });
	} catch (error) {
		console.error("Error creating checkout session:", error);
		return Response.json({ error: true }, { status: 500 });
	}
}
