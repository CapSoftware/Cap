import type { ProductEventPlatform } from "@cap/analytics";
import type Stripe from "stripe";
import { queueServerProductEvent } from "./server";
import type { ServerProductEvent } from "./server-event";

type AnalyticsUser = {
	id: string;
};

export function isSettledSubscriptionPurchase(
	session: Stripe.Checkout.Session,
) {
	return session.payment_status === "paid";
}

export function subscriptionCheckoutAnalyticsMetadata(input: {
	platform: Exclude<ProductEventPlatform, "server">;
	priceId: string;
	quantity: number;
	organizationId?: string | null;
	anonymousId?: string;
	isFirstPurchase: boolean;
	isGuestCheckout?: boolean;
	isOnboarding?: boolean;
}) {
	return {
		analyticsSchemaVersion: "1",
		analyticsPriceId: input.priceId,
		analyticsQuantity: String(input.quantity),
		analyticsIsFirstPurchase: input.isFirstPurchase ? "true" : "false",
		platform: input.platform,
		...(input.organizationId
			? { analyticsOrganizationId: input.organizationId }
			: {}),
		...(input.anonymousId ? { analyticsAnonymousId: input.anonymousId } : {}),
		...(input.isGuestCheckout ? { guestCheckout: "true" } : {}),
		...(input.isOnboarding === undefined
			? {}
			: { isOnBoarding: input.isOnboarding ? "true" : "false" }),
	};
}

export function subscriptionCheckoutProductEvent({
	eventId,
	occurredAt,
	session,
	user,
}: {
	eventId: string;
	occurredAt: string;
	session: Stripe.Checkout.Session;
	user: AnalyticsUser;
}): ServerProductEvent | null {
	const isGuestCheckout = session.metadata?.guestCheckout === "true";
	const platform =
		session.metadata?.platform === "desktop"
			? "desktop"
			: session.metadata?.platform === "mobile"
				? "mobile"
				: session.metadata?.platform === "cli"
					? "cli"
					: session.metadata?.platform === "web"
						? "web"
						: "server";
	const anonymousId = session.metadata?.analyticsAnonymousId;
	const analyticsSchemaVersion = session.metadata?.analyticsSchemaVersion;
	if (!analyticsSchemaVersion) return null;
	if (analyticsSchemaVersion !== "1") {
		throw new Error("Stripe checkout has an unsupported analytics schema");
	}
	const metadataQuantity = Number(session.metadata?.analyticsQuantity);
	if (
		!Number.isSafeInteger(metadataQuantity) ||
		metadataQuantity < 1 ||
		!session.metadata?.analyticsPriceId
	) {
		throw new Error("Stripe checkout is missing analytics metadata");
	}
	const quantity = metadataQuantity;
	const priceId = session.metadata?.analyticsPriceId;
	const organizationId = session.metadata?.analyticsOrganizationId;
	if (!isSettledSubscriptionPurchase(session)) return null;

	return {
		eventId: `stripe:${eventId}:purchase_completed`,
		eventName: "purchase_completed",
		occurredAt,
		anonymousId,
		platform,
		userId: user.id,
		organizationId,
		properties: {
			payment_status: "paid",
			subscription_status: "paid_checkout",
			amount_total_minor: session.amount_total,
			amount_subtotal_minor: session.amount_subtotal,
			discount_amount_minor: session.total_details?.amount_discount,
			currency: session.currency,
			invite_quota: quantity,
			price_id: priceId,
			quantity,
			is_onboarding: session.metadata?.isOnBoarding === "true",
			is_first_purchase: session.metadata?.analyticsIsFirstPurchase === "true",
			is_guest_checkout: isGuestCheckout,
		},
	};
}

export function subscriptionTrialStartedProductEvent({
	eventId,
	occurredAt,
	subscription,
	user,
}: {
	eventId: string;
	occurredAt: string;
	subscription: Stripe.Subscription;
	user: AnalyticsUser;
}): ServerProductEvent | null {
	if (subscription.status !== "trialing") return null;
	const metadata = subscription.metadata;
	if (!metadata.analyticsSchemaVersion) return null;
	if (metadata.analyticsSchemaVersion !== "1") {
		throw new Error("Stripe subscription has an unsupported analytics schema");
	}
	const quantity = Number(metadata.analyticsQuantity);
	if (
		!Number.isSafeInteger(quantity) ||
		quantity < 1 ||
		!metadata.analyticsPriceId
	) {
		throw new Error("Stripe subscription is missing analytics metadata");
	}
	const platform =
		metadata.platform === "desktop"
			? "desktop"
			: metadata.platform === "mobile"
				? "mobile"
				: metadata.platform === "cli"
					? "cli"
					: metadata.platform === "web"
						? "web"
						: null;
	if (!platform) throw new Error("Stripe subscription has an invalid platform");
	const price = subscription.items.data[0]?.price;
	return {
		eventId: `stripe:${eventId}:trial_started`,
		eventName: "trial_started",
		occurredAt,
		anonymousId: metadata.analyticsAnonymousId,
		platform,
		userId: user.id,
		organizationId: metadata.analyticsOrganizationId,
		properties: {
			subscription_status: "trialing",
			trial_end_at: subscription.trial_end,
			price_id: metadata.analyticsPriceId,
			quantity,
			currency: price?.currency ?? null,
			unit_amount_minor: price?.unit_amount ?? null,
			billing_interval: price?.recurring?.interval ?? null,
			billing_interval_count: price?.recurring?.interval_count ?? null,
			is_guest_checkout: metadata.guestCheckout === "true",
			is_onboarding: metadata.isOnBoarding === "true",
		},
	};
}

export async function queueSubscriptionCheckoutProductEvent(
	input: Parameters<typeof subscriptionCheckoutProductEvent>[0],
) {
	const event = subscriptionCheckoutProductEvent(input);
	if (event) await queueServerProductEvent(event);
}

export async function queueSubscriptionTrialStartedProductEvent(
	input: Parameters<typeof subscriptionTrialStartedProductEvent>[0],
) {
	const event = subscriptionTrialStartedProductEvent(input);
	if (event) await queueServerProductEvent(event);
}
