"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { stripe } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { calculateProSeats } from "@/utils/organization";

async function getOwnerSubscription(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization) throw new Error("Organization not found");
	if (organization.ownerId !== user.id)
		throw new Error("Only the owner can manage seats");

	const [owner] = await db()
		.select({
			stripeSubscriptionId: users.stripeSubscriptionId,
			stripeCustomerId: users.stripeCustomerId,
			inviteQuota: users.inviteQuota,
		})
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	if (!owner?.stripeSubscriptionId || !owner.stripeCustomerId) {
		throw new Error("No active subscription found");
	}

	const subscription = await stripe().subscriptions.retrieve(
		owner.stripeSubscriptionId,
	);

	const subscriptionItem = subscription.items.data[0];
	if (!subscriptionItem) {
		throw new Error("No subscription item found");
	}

	const allMembers = await db()
		.select({
			id: organizationMembers.id,
			hasProSeat: organizationMembers.hasProSeat,
		})
		.from(organizationMembers)
		.where(eq(organizationMembers.organizationId, organizationId));

	const { proSeatsUsed } = calculateProSeats({
		inviteQuota: owner.inviteQuota ?? 1,
		members: allMembers,
	});

	return { owner, subscription, subscriptionItem, proSeatsUsed, user };
}

const MAX_SEATS = 500;

function validateQuantity(quantity: number): void {
	if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SEATS) {
		throw new Error(`Quantity must be an integer between 1 and ${MAX_SEATS}`);
	}
}

export async function previewSeatChange(
	organizationId: Organisation.OrganisationId,
	newQuantity: number,
) {
	validateQuantity(newQuantity);
	const { owner, subscriptionItem, proSeatsUsed } =
		await getOwnerSubscription(organizationId);

	if (newQuantity < proSeatsUsed) {
		throw new Error(
			`Cannot reduce below ${proSeatsUsed} seats (currently assigned)`,
		);
	}

	const preview = await stripe().invoices.retrieveUpcoming({
		customer: owner.stripeCustomerId,
		subscription: owner.stripeSubscriptionId,
		subscription_items: [
			{
				id: subscriptionItem.id,
				quantity: newQuantity,
			},
		],
		subscription_proration_behavior: "create_prorations",
	});

	const currentQuantity = subscriptionItem.quantity || 1;
	const proratedAmount = preview.amount_due;
	const nextPaymentDate = preview.period_end;

	return {
		proratedAmount,
		nextPaymentDate,
		currentQuantity,
		newQuantity,
		currency: preview.currency,
	};
}

export async function updateSeatQuantity(
	organizationId: Organisation.OrganisationId,
	newQuantity: number,
) {
	validateQuantity(newQuantity);
	const { subscription, subscriptionItem, proSeatsUsed, user } =
		await getOwnerSubscription(organizationId);

	if (newQuantity < proSeatsUsed) {
		throw new Error(
			`Cannot reduce below ${proSeatsUsed} seats (currently assigned)`,
		);
	}

	await stripe().subscriptions.update(subscription.id, {
		items: [
			{
				id: subscriptionItem.id,
				quantity: newQuantity,
			},
		],
		proration_behavior: "create_prorations",
	});

	await db()
		.update(users)
		.set({ inviteQuota: newQuantity })
		.where(eq(users.id, user.id));

	revalidatePath("/dashboard/settings/organization");

	return { success: true, newQuantity };
}
