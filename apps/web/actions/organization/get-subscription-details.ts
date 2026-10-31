"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, users } from "@cap/database/schema";
import { isProSubscription, stripe } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

export type SubscriptionDetails = {
	planName: string;
	status: string;
	billingInterval: "month" | "year";
	pricePerSeat: number;
	currentQuantity: number;
	currentPeriodEnd: number;
	currency: string;
	cancelAtPeriodEnd: boolean;
};

// Tiered prices have no unit_amount; the per-seat cost depends on the tier
// the quantity lands in (volume) or the blend across tiers (graduated).
function seatUnitAmount(price: Stripe.Price, quantity: number): number {
	if (price.billing_scheme !== "tiered") return price.unit_amount ?? 0;
	const tiers = price.tiers ?? [];
	const seats = Math.max(quantity, 1);

	if (price.tiers_mode === "volume") {
		const tier =
			tiers.find((t) => t.up_to === null || seats <= t.up_to) ?? tiers.at(-1);
		if (!tier) return 0;
		return (tier.unit_amount ?? 0) + (tier.flat_amount ?? 0) / seats;
	}

	let total = 0;
	let counted = 0;
	for (const tier of tiers) {
		const inTier = Math.min(seats, tier.up_to ?? seats) - counted;
		if (inTier <= 0) continue;
		total += inTier * (tier.unit_amount ?? 0) + (tier.flat_amount ?? 0);
		counted += inTier;
		if (counted >= seats) break;
	}
	return total / seats;
}

export async function getSubscriptionDetails(
	organizationId: Organisation.OrganisationId,
): Promise<SubscriptionDetails | null> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization) throw new Error("Organization not found");
	if (organization.ownerId !== user.id)
		throw new Error("Only the owner can view subscription details");

	const [owner] = await db()
		.select({
			stripeSubscriptionId: users.stripeSubscriptionId,
			stripeCustomerId: users.stripeCustomerId,
		})
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	if (!owner?.stripeSubscriptionId) {
		return null;
	}

	const subscription = await stripe().subscriptions.retrieve(
		owner.stripeSubscriptionId,
		{ expand: ["items.data.price.tiers"] },
	);
	const customerId =
		typeof subscription.customer === "string"
			? subscription.customer
			: subscription.customer.id;
	if (!isProSubscription(subscription) || customerId !== owner.stripeCustomerId)
		return null;

	// past_due renders as a payment-failed state in the billing card rather
	// than falling through to the "Upgrade to Pro" card.
	if (
		subscription.status !== "active" &&
		subscription.status !== "trialing" &&
		subscription.status !== "past_due"
	) {
		return null;
	}

	const item = subscription.items.data[0];
	if (!item) return null;

	const price = item.price;
	const unitAmount = seatUnitAmount(price, item.quantity ?? 1);
	const interval = price.recurring?.interval === "year" ? "year" : "month";
	const pricePerSeat =
		interval === "year" ? unitAmount / 100 / 12 : unitAmount / 100;

	return {
		planName: "Cap Pro",
		status: subscription.status,
		billingInterval: interval,
		pricePerSeat,
		currentQuantity: item.quantity ?? 1,
		currentPeriodEnd: subscription.current_period_end,
		currency: price.currency,
		cancelAtPeriodEnd: subscription.cancel_at_period_end,
	};
}
