import type Stripe from "stripe";
import { queueServerProductEvent } from "./server";
import type { ServerProductEvent } from "./server-event";

type AnalyticsUser = {
	id: string;
	activeOrganizationId?: string | null;
};

export function isSettledSubscriptionPurchase(
	session: Stripe.Checkout.Session,
	subscription: Stripe.Subscription,
) {
	return (
		session.payment_status === "paid" &&
		(subscription.status === "active" || subscription.status === "trialing")
	);
}

export function isStartedSubscriptionTrial(
	session: Stripe.Checkout.Session,
	subscription: Stripe.Subscription,
) {
	return (
		session.payment_status === "no_payment_required" &&
		subscription.status === "trialing"
	);
}

export function subscriptionCheckoutProductEvent({
	eventId,
	occurredAt,
	session,
	subscription,
	inviteQuota,
	user,
}: {
	eventId: string;
	occurredAt: string;
	session: Stripe.Checkout.Session;
	subscription: Stripe.Subscription;
	inviteQuota: number;
	user: AnalyticsUser;
}): ServerProductEvent | null {
	const isGuestCheckout = session.metadata?.guestCheckout === "true";
	const platform =
		session.metadata?.platform === "desktop"
			? "desktop"
			: session.metadata?.platform === "mobile"
				? "mobile"
				: session.metadata?.platform === "web"
					? "web"
					: "server";
	const anonymousId = session.metadata?.analyticsAnonymousId;
	const price = subscription.items.data[0]?.price;
	if (isStartedSubscriptionTrial(session, subscription)) {
		return {
			eventId: `stripe:${eventId}:trial_started`,
			eventName: "trial_started",
			occurredAt,
			anonymousId,
			platform,
			userId: user.id,
			organizationId: user.activeOrganizationId ?? undefined,
			properties: {
				subscription_status: "trialing",
				trial_end_at: subscription.trial_end ?? null,
				price_id: price?.id ?? null,
				quantity: inviteQuota,
				currency: price?.currency ?? null,
				unit_amount_minor: price?.unit_amount ?? null,
				billing_interval: price?.recurring?.interval ?? null,
				billing_interval_count: price?.recurring?.interval_count ?? null,
				is_guest_checkout: isGuestCheckout,
				is_onboarding: session.metadata?.isOnBoarding === "true",
			},
		};
	}

	if (!isSettledSubscriptionPurchase(session, subscription)) return null;

	return {
		eventId: `stripe:${eventId}:purchase_completed`,
		eventName: "purchase_completed",
		occurredAt,
		anonymousId,
		platform,
		userId: user.id,
		organizationId: user.activeOrganizationId ?? undefined,
		properties: {
			payment_status: "paid",
			subscription_status: subscription.status,
			amount_total_minor: session.amount_total,
			amount_subtotal_minor: session.amount_subtotal,
			discount_amount_minor: session.total_details?.amount_discount,
			currency: session.currency,
			unit_amount_minor: price?.unit_amount,
			billing_interval: price?.recurring?.interval,
			billing_interval_count: price?.recurring?.interval_count,
			invite_quota: inviteQuota,
			price_id: price?.id,
			quantity: inviteQuota,
			is_onboarding: session.metadata?.isOnBoarding === "true",
			is_first_purchase: session.metadata?.analyticsIsFirstPurchase === "true",
			is_guest_checkout: isGuestCheckout,
		},
	};
}

export async function queueSubscriptionCheckoutProductEvent(
	input: Parameters<typeof subscriptionCheckoutProductEvent>[0],
) {
	const event = subscriptionCheckoutProductEvent(input);
	if (event) await queueServerProductEvent(event);
}
