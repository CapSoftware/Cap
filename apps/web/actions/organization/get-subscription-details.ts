"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, users } from "@cap/database/schema";
import { stripe } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export type SubscriptionDetails = {
	planName: string;
	status: string;
	billingInterval: "month" | "year";
	pricePerSeat: number;
	currentQuantity: number;
	currentPeriodEnd: number;
	currency: string;
};

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
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
		})
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	if (!owner?.stripeSubscriptionId) {
		return null;
	}

	const subscription = await stripe().subscriptions.retrieve(
		owner.stripeSubscriptionId,
	);

	if (subscription.status !== "active" && subscription.status !== "trialing") {
		return null;
	}

	const item = subscription.items.data[0];
	if (!item) return null;

	const price = item.price;
	const unitAmount = price.unit_amount ?? 0;
	const interval = price.recurring?.interval === "year" ? "year" : "month";
	const pricePerSeat =
		interval === "year" ? unitAmount / 100 / 12 : unitAmount / 100;

	return {
		planName: "Cap Pro",
		status: subscription.status,
		billingInterval: interval,
		pricePerSeat,
		currentQuantity: item.quantity || 1,
		currentPeriodEnd: subscription.current_period_end,
		currency: price.currency,
	};
}
