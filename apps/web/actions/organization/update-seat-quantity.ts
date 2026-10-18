"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { isProSubscription, stripe } from "@cap/utils";
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
	const customerId =
		typeof subscription.customer === "string"
			? subscription.customer
			: subscription.customer.id;
	if (
		!isProSubscription(subscription) ||
		customerId !== owner.stripeCustomerId
	) {
		throw new Error("No matching Cap Pro subscription found");
	}

	const subscriptionItem = subscription.items.data[0];
	if (!subscriptionItem) {
		throw new Error("No subscription item found");
	}

	const allMembers = await db()
		.select({
			id: organizationMembers.id,
			userId: organizationMembers.userId,
			hasProSeat: organizationMembers.hasProSeat,
		})
		.from(organizationMembers)
		.where(eq(organizationMembers.organizationId, organizationId));

	const { proSeatsUsed } = calculateProSeats({
		inviteQuota: owner.inviteQuota ?? 1,
		ownerId: user.id,
		ownerIsPro: true,
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
	const { owner, subscription, subscriptionItem, proSeatsUsed } =
		await getOwnerSubscription(organizationId);
	const customerId = owner.stripeCustomerId;
	const subscriptionId = owner.stripeSubscriptionId;

	if (!customerId || !subscriptionId) {
		throw new Error("No active subscription found");
	}

	if (newQuantity < proSeatsUsed) {
		throw new Error(
			`Cannot reduce below ${proSeatsUsed} seats (currently assigned)`,
		);
	}

	const currentQuantity = subscriptionItem.quantity ?? 1;

	// Decreases don't prorate: the current period stays fully paid and no
	// credit is issued, so the preview must not advertise one.
	const previewParams = {
		customer: customerId,
		subscription: subscriptionId,
		subscription_items: [
			{
				id: subscriptionItem.id,
				quantity: newQuantity,
			},
		],
		subscription_proration_behavior:
			newQuantity > currentQuantity
				? ("create_prorations" as const)
				: ("none" as const),
	};

	const preview = await stripe().invoices.retrieveUpcoming(previewParams);
	const previewLines = preview.lines.has_more
		? await stripe()
				.invoices.listUpcomingLines(previewParams)
				.autoPagingToArray({ limit: 1000 })
		: preview.lines.data;

	let proratedAmount = previewLines.reduce((total, line) => {
		if (!line.proration) return total;
		return total + line.amount;
	}, 0);

	if (proratedAmount === 0 && newQuantity !== currentQuantity) {
		const currentPeriodEnd = subscription.current_period_end;
		proratedAmount = previewLines.reduce((total, line) => {
			if (line.period.end <= currentPeriodEnd) {
				return total + line.amount;
			}
			return total;
		}, 0);
	}

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
	if (
		!Number.isInteger(newQuantity) ||
		newQuantity < 0 ||
		newQuantity > MAX_SEATS
	) {
		throw new Error(`Quantity must be an integer between 0 and ${MAX_SEATS}`);
	}
	const { subscription, subscriptionItem, proSeatsUsed, user } =
		await getOwnerSubscription(organizationId);
	const currentQuantity = subscriptionItem.quantity ?? 1;

	// Zero seats means canceling Cap Pro. The paid period stays active until
	// it expires (no refund); the deletion webhook then downgrades the account
	// and cancels any Signed BAA subscription.
	if (newQuantity === 0) {
		if (proSeatsUsed > 1) {
			throw new Error(
				"Remove Pro seats from your members before canceling the subscription",
			);
		}
		await stripe().subscriptions.update(subscription.id, {
			cancel_at_period_end: true,
		});
		revalidatePath("/dashboard/settings/organization");
		return {
			success: true,
			newQuantity: currentQuantity,
			cancelAtPeriodEnd: true,
		};
	}

	if (newQuantity < proSeatsUsed) {
		throw new Error(
			`Cannot reduce below ${proSeatsUsed} seats (currently assigned)`,
		);
	}

	const isSeatIncrease = newQuantity > currentQuantity;
	const wasCanceling = subscription.cancel_at_period_end;
	// Stripe rejects cancel_at_period_end combined with
	// payment_behavior=pending_if_incomplete, so increases clear cancellation
	// first. Every failure path afterwards must re-schedule it: the committed
	// quantity self-heals locally via the customer.subscription.updated
	// webhook, but nothing re-schedules a dropped cancellation, which would
	// silently resume renewal.
	const restoreScheduledCancellation = async (failureMessage: string) => {
		try {
			await stripe().subscriptions.update(subscription.id, {
				cancel_at_period_end: true,
			});
		} catch (restoreError) {
			console.error(
				"Failed to restore scheduled Cap Pro cancellation",
				subscription.id,
				restoreError,
			);
			throw new Error(failureMessage);
		}
	};

	try {
		if (isSeatIncrease && wasCanceling) {
			await stripe().subscriptions.update(subscription.id, {
				cancel_at_period_end: false,
			});
		}

		const updatedSubscription = await stripe().subscriptions.update(
			subscription.id,
			{
				items: [
					{
						id: subscriptionItem.id,
						quantity: newQuantity,
					},
				],
				proration_behavior: isSeatIncrease ? "always_invoice" : "none",
				...(isSeatIncrease
					? { payment_behavior: "pending_if_incomplete" as const }
					: {}),
				...(!isSeatIncrease && wasCanceling
					? { cancel_at_period_end: false }
					: {}),
			},
		);

		if (isSeatIncrease && updatedSubscription.pending_update) {
			throw new Error(
				"Payment for the added seats could not be completed. Update your payment method and try again.",
			);
		}
	} catch (error) {
		if (wasCanceling) {
			await restoreScheduledCancellation(
				"We couldn't complete the seat change or keep your scheduled cancellation. Please contact support.",
			);
		}
		throw error;
	}

	try {
		await db()
			.update(users)
			.set({ inviteQuota: newQuantity })
			.where(eq(users.id, user.id));
	} catch (dbError) {
		console.error(
			"CRITICAL: Stripe updated to quantity",
			newQuantity,
			"but DB update failed for user",
			user.id,
			dbError,
		);
		// The committed quantity stays: the customer.subscription.updated
		// webhook recomputes inviteQuota from Stripe, so local state
		// self-heals. Only the cleared cancellation needs compensating here.
		if (wasCanceling) {
			await restoreScheduledCancellation(
				`Billing was updated to ${newQuantity} seats, but we couldn't save it locally or keep your scheduled cancellation. Please contact support.`,
			);
			throw new Error(
				`Billing was updated to ${newQuantity} seats and your scheduled cancellation was kept. Saving it locally failed; it will sync automatically shortly.`,
			);
		}
		throw new Error(
			`Billing was updated to ${newQuantity} seats, but saving it locally failed. It will sync automatically shortly; refresh to confirm before retrying.`,
		);
	}

	revalidatePath("/dashboard/settings/organization");

	return { success: true, newQuantity, cancelAtPeriodEnd: false };
}
