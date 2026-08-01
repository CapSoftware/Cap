import type { ProductEventPlatform } from "@cap/analytics";
import type Stripe from "stripe";
import { queueServerProductEvent } from "./server";
import type { ServerProductEvent } from "./server-event";

type AnalyticsUser = {
	id: string;
};

const subscriptionAnalyticsPlatform = (
	subscription: Stripe.Subscription,
): ProductEventPlatform => {
	const platform = subscription.metadata.platform;
	return platform === "web" ||
		platform === "desktop" ||
		platform === "mobile" ||
		platform === "cli"
		? platform
		: "server";
};

const subscriptionOrganizationId = (subscription: Stripe.Subscription) =>
	subscription.metadata.analyticsOrganizationId || undefined;

const subscriptionPrice = (subscription: Stripe.Subscription) => {
	const item = subscription.items.data[0];
	if (!item?.price.id) {
		throw new Error("Subscription is missing its Stripe price");
	}
	return { item, price: item.price };
};

export function subscriptionInvoicePriceId(invoice: Stripe.Invoice): string {
	const priceId = invoice.lines.data.find((line) => line.price)?.price?.id;
	if (!priceId) {
		throw new Error("Subscription invoice is missing its Stripe price");
	}
	return priceId;
}

export async function isFirstPositiveSubscriptionPayment({
	invoice,
	subscriptionId,
	listPaidInvoices,
}: {
	invoice: Stripe.Invoice;
	subscriptionId: string;
	listPaidInvoices: (input: {
		subscription: string;
		status: "paid";
		created: { lt: number };
		limit: 100;
		starting_after?: string;
	}) => Promise<{ data: Stripe.Invoice[]; has_more: boolean }>;
}) {
	let startingAfter: string | undefined;
	for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
		const page = await listPaidInvoices({
			subscription: subscriptionId,
			status: "paid",
			created: { lt: invoice.created },
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		if (page.data.some((candidate) => candidate.amount_paid > 0)) return false;
		if (!page.has_more || page.data.length === 0) return true;
		startingAfter = page.data.at(-1)?.id;
		if (!startingAfter) break;
	}
	throw new Error("Subscription invoice history exceeded the analytics bound");
}

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

export function subscriptionInvoicePaidProductEvent({
	eventId,
	occurredAt,
	invoice,
	subscription,
	user,
	firstPositivePayment,
}: {
	eventId: string;
	occurredAt: string;
	invoice: Stripe.Invoice;
	subscription: Stripe.Subscription;
	user: AnalyticsUser;
	firstPositivePayment: boolean;
}): ServerProductEvent | null {
	if (
		invoice.billing_reason !== "subscription_cycle" ||
		invoice.amount_paid <= 0
	) {
		return null;
	}
	const { item, price } = subscriptionPrice(subscription);
	if (!firstPositivePayment) {
		return {
			eventId: `stripe:${eventId}:subscription_renewed`,
			eventName: "subscription_renewed",
			occurredAt,
			platform: "server",
			userId: user.id,
			organizationId: subscriptionOrganizationId(subscription),
			properties: {
				amount_paid_minor: invoice.amount_paid,
				currency: invoice.currency,
				price_id: price.id,
				billing_reason: "subscription_cycle",
			},
		};
	}
	const discountAmount = invoice.total_discount_amounts?.reduce(
		(sum, discount) => sum + discount.amount,
		0,
	);
	return {
		eventId: `stripe:${eventId}:purchase_completed`,
		eventName: "purchase_completed",
		occurredAt,
		anonymousId: subscription.metadata.analyticsAnonymousId,
		platform: subscriptionAnalyticsPlatform(subscription),
		userId: user.id,
		organizationId: subscriptionOrganizationId(subscription),
		properties: {
			payment_status: "paid",
			subscription_status: subscription.status,
			amount_total_minor: invoice.amount_paid,
			amount_subtotal_minor: invoice.subtotal,
			discount_amount_minor: discountAmount ?? null,
			currency: invoice.currency,
			unit_amount_minor: price.unit_amount,
			billing_interval: price.recurring?.interval ?? null,
			billing_interval_count: price.recurring?.interval_count ?? null,
			invite_quota: item.quantity ?? null,
			price_id: price.id,
			quantity: item.quantity ?? null,
			is_first_purchase: true,
			is_guest_checkout: subscription.metadata.guestCheckout === "true",
			is_onboarding: subscription.metadata.isOnBoarding === "true",
		},
	};
}

export function subscriptionPaymentFailedProductEvent({
	eventId,
	occurredAt,
	invoice,
	subscription,
	user,
}: {
	eventId: string;
	occurredAt: string;
	invoice: Stripe.Invoice;
	subscription: Stripe.Subscription;
	user: AnalyticsUser;
}): ServerProductEvent | null {
	if (invoice.amount_due <= 0) return null;
	return {
		eventId: `stripe:${eventId}:subscription_payment_failed`,
		eventName: "subscription_payment_failed",
		occurredAt,
		platform: "server",
		userId: user.id,
		organizationId: subscriptionOrganizationId(subscription),
		properties: {
			amount_due_minor: invoice.amount_due,
			currency: invoice.currency,
			attempt_count: invoice.attempt_count,
			price_id: subscriptionInvoicePriceId(invoice),
		},
	};
}

export function subscriptionRefundedProductEvent({
	eventId,
	occurredAt,
	charge,
	invoice,
	subscription,
	user,
	refundedAmount,
}: {
	eventId: string;
	occurredAt: string;
	charge: Stripe.Charge;
	invoice: Stripe.Invoice;
	subscription: Stripe.Subscription;
	user: AnalyticsUser;
	refundedAmount: number;
}): ServerProductEvent | null {
	if (refundedAmount <= 0) return null;
	return {
		eventId: `stripe:${eventId}:subscription_refunded`,
		eventName: "subscription_refunded",
		occurredAt,
		platform: "server",
		userId: user.id,
		organizationId: subscriptionOrganizationId(subscription),
		properties: {
			amount_refunded_minor: refundedAmount,
			currency: charge.currency,
			price_id: subscriptionInvoicePriceId(invoice),
			fully_refunded: charge.refunded,
		},
	};
}

export function subscriptionTrialConvertedProductEvent({
	eventId,
	occurredAt,
	subscription,
	previousStatus,
	user,
}: {
	eventId: string;
	occurredAt: string;
	subscription: Stripe.Subscription;
	previousStatus?: Stripe.Subscription.Status;
	user: AnalyticsUser;
}): ServerProductEvent | null {
	if (previousStatus !== "trialing" || subscription.status !== "active") {
		return null;
	}
	const { price } = subscriptionPrice(subscription);
	return {
		eventId: `stripe:${eventId}:trial_converted`,
		eventName: "trial_converted",
		occurredAt,
		platform: "server",
		userId: user.id,
		organizationId: subscriptionOrganizationId(subscription),
		properties: {
			previous_status: "trialing",
			new_status: "active",
			price_id: price.id,
		},
	};
}

export function subscriptionChangedProductEvents({
	eventId,
	occurredAt,
	subscription,
	previous,
	user,
}: {
	eventId: string;
	occurredAt: string;
	subscription: Stripe.Subscription;
	previous?: Partial<Stripe.Subscription>;
	user: AnalyticsUser;
}): ServerProductEvent[] {
	const events: ServerProductEvent[] = [];
	const { item: currentItem, price } = subscriptionPrice(subscription);
	const organizationId = subscriptionOrganizationId(subscription);
	const base = {
		occurredAt,
		platform: "server" as const,
		userId: user.id,
		organizationId,
	};
	if (
		previous?.cancel_at_period_end !== undefined &&
		previous.cancel_at_period_end !== subscription.cancel_at_period_end
	) {
		events.push({
			...base,
			eventId: `stripe:${eventId}:subscription_changed:cancellation`,
			eventName: "subscription_changed",
			properties: {
				change_kind: subscription.cancel_at_period_end
					? "cancellation_scheduled"
					: "cancellation_reversed",
				previous_status: previous.status ?? null,
				new_status: subscription.status,
				previous_price_id: null,
				new_price_id: price.id,
				previous_quantity: null,
				new_quantity: null,
			},
		});
	}
	if (previous?.status && previous.status !== subscription.status) {
		events.push({
			...base,
			eventId: `stripe:${eventId}:subscription_changed:status`,
			eventName: "subscription_changed",
			properties: {
				change_kind: "status",
				previous_status: previous.status,
				new_status: subscription.status,
				previous_price_id: null,
				new_price_id: price.id,
				previous_quantity: null,
				new_quantity: null,
			},
		});
	}
	const previousItem = previous?.items?.data[0];
	if (
		previousItem?.price.id &&
		previousItem.price.id !== currentItem.price.id
	) {
		events.push({
			...base,
			eventId: `stripe:${eventId}:subscription_changed:plan`,
			eventName: "subscription_changed",
			properties: {
				change_kind: "plan",
				previous_status: null,
				new_status: null,
				previous_price_id: previousItem.price.id,
				new_price_id: currentItem.price.id,
				previous_quantity: previousItem.quantity ?? null,
				new_quantity: currentItem.quantity ?? null,
			},
		});
	}
	if (previousItem && previousItem.quantity !== currentItem.quantity) {
		events.push({
			...base,
			eventId: `stripe:${eventId}:subscription_changed:seats`,
			eventName: "subscription_changed",
			properties: {
				change_kind: "seats",
				previous_status: null,
				new_status: null,
				previous_price_id: previousItem.price.id,
				new_price_id: currentItem.price.id,
				previous_quantity: previousItem.quantity ?? null,
				new_quantity: currentItem.quantity ?? null,
			},
		});
	}
	return events;
}

export function subscriptionCancelledProductEvent({
	eventId,
	occurredAt,
	subscription,
	user,
}: {
	eventId: string;
	occurredAt: string;
	subscription: Stripe.Subscription;
	user: AnalyticsUser;
}): ServerProductEvent {
	const { price } = subscriptionPrice(subscription);
	return {
		eventId: `stripe:${eventId}:subscription_cancelled`,
		eventName: "subscription_cancelled",
		occurredAt,
		platform: "server",
		userId: user.id,
		organizationId: subscriptionOrganizationId(subscription),
		properties: {
			status: subscription.status,
			price_id: price.id,
			ended_at: subscription.ended_at,
			cancel_at_period_end: subscription.cancel_at_period_end,
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
