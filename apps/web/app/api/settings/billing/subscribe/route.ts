import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe, userIsPro } from "@cap/utils";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { checkoutStartedEvent } from "@/lib/analytics/business-events";
import {
	queueServerProductEvent,
	readAnalyticsAnonymousId,
} from "@/lib/analytics/server";
import { subscriptionCheckoutAnalyticsMetadata } from "@/lib/analytics/stripe-business-events";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	let customerId = user?.stripeCustomerId;
	const { priceId, quantity, isOnBoarding } = await request.json();
	const analyticsAnonymousId = readAnalyticsAnonymousId(request);

	if (!priceId) {
		console.error("Price ID not found");
		return Response.json({ error: true }, { status: 400 });
	}

	if (!user) {
		console.error("User not found");
		return Response.json({ error: true, auth: false }, { status: 401 });
	}

	if (userIsPro(user)) {
		console.error("User already has pro plan");
		return Response.json({ error: true, subscription: true }, { status: 400 });
	}

	try {
		if (!user.stripeCustomerId) {
			const existingCustomers = await stripe().customers.list({
				email: user.email,
				limit: 1,
			});

			let customer: Stripe.Customer;
			if (existingCustomers.data.length > 0 && existingCustomers.data[0]) {
				customer = existingCustomers.data[0];

				customer = await stripe().customers.update(customer.id, {
					metadata: {
						...customer.metadata,
						userId: user.id,
					},
				});
			} else {
				customer = await stripe().customers.create({
					email: user.email,
					metadata: {
						userId: user.id,
					},
				});
			}

			await db()
				.update(users)
				.set({
					stripeCustomerId: customer.id,
				})
				.where(eq(users.id, user.id));
			customerId = customer.id;
		}

		const analyticsMetadata = subscriptionCheckoutAnalyticsMetadata({
			platform: "web",
			priceId,
			quantity: quantity ?? 1,
			organizationId: user.activeOrganizationId,
			anonymousId: analyticsAnonymousId,
			isFirstPurchase: !user.stripeSubscriptionId,
			isOnboarding: Boolean(isOnBoarding),
		});
		const checkoutSession = await stripe().checkout.sessions.create({
			customer: customerId as string,
			line_items: [{ price: priceId, quantity: quantity }],
			mode: "subscription",
			success_url: isOnBoarding
				? `${serverEnv().WEB_URL}/dashboard/settings/organization?upgrade=true&session_id={CHECKOUT_SESSION_ID}`
				: `${serverEnv().WEB_URL}/dashboard/caps?upgrade=true&session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: isOnBoarding
				? `${serverEnv().WEB_URL}/onboarding`
				: `${serverEnv().WEB_URL}/pricing`,
			allow_promotion_codes: true,
			metadata: {
				dubCustomerId: user.id,
				...analyticsMetadata,
			},
			subscription_data: { metadata: analyticsMetadata },
		});

		if (checkoutSession.url) {
			await queueServerProductEvent(
				checkoutStartedEvent({
					checkoutId: checkoutSession.id,
					createdAt: new Date(checkoutSession.created * 1_000),
					anonymousId: analyticsAnonymousId,
					platform: "web",
					userId: user.id,
					organizationId: user.activeOrganizationId,
					priceId,
					quantity: quantity ?? 1,
					isOnboarding: Boolean(isOnBoarding),
				}),
			).catch(() => {
				console.warn(
					"Checkout analytics enqueue failed; reconciliation pending",
				);
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
