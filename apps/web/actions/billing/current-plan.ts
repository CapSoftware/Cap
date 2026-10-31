"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import {
	getSubscriptionDetails,
	type SubscriptionDetails,
} from "@/actions/organization/get-subscription-details";
import {
	previewSeatChange,
	updateSeatQuantity,
} from "@/actions/organization/update-seat-quantity";

export type CurrentPlan =
	| { type: "managed"; details: SubscriptionDetails }
	| { type: "setup" }
	| { type: "external" }
	| { type: "development" }
	| { type: "unavailable" };

export type SeatPreviewResult =
	| {
			ok: true;
			proratedAmount: number;
			recurringAmount: number;
			nextPaymentDate: number;
			currency: string;
	  }
	| { ok: false; message: string };

export type AddSeatsResult =
	| { ok: true; quantity: number }
	| { ok: false; message: string };

const errorMessage = (error: unknown, fallback: string) =>
	error instanceof Error && error.message ? error.message : fallback;

// Seat changes live on the organization the subscriber owns; the active
// organization may be one they were only invited to.
async function ownedOrganizationId() {
	const user = await getCurrentUser();
	if (!user) return null;

	const owned = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.where(
			and(
				eq(organizations.ownerId, user.id),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(50);

	return (
		owned.find((org) => org.id === user.activeOrganizationId)?.id ??
		owned[0]?.id ??
		null
	);
}

export async function getCurrentPlan(): Promise<CurrentPlan> {
	const user = await getCurrentUser();
	// Pro without a subscription of their own means a seat in someone else's
	// organization or a third-party arrangement; there is nothing to buy here.
	if (!user?.stripeSubscriptionId) return { type: "external" };
	// The dev toolbar's "Promote to Pro" writes this placeholder instead of a
	// real Stripe subscription.
	if (user.stripeSubscriptionId === "development") {
		return { type: "development" };
	}

	const organizationId = await ownedOrganizationId();
	if (!organizationId) return { type: "setup" };

	try {
		const details = await getSubscriptionDetails(organizationId);
		if (details) return { type: "managed", details };
		console.error("Cap Pro subscription is not in a manageable state", {
			userId: user.id,
		});
		return { type: "unavailable" };
	} catch (error) {
		console.error("Failed to load the current Cap Pro plan:", error);
		return { type: "unavailable" };
	}
}

async function currentQuantity(organizationId: Organisation.OrganisationId) {
	const details = await getSubscriptionDetails(organizationId);
	if (!details) throw new Error("No active Cap Pro subscription found.");
	return details.currentQuantity;
}

export async function previewAddSeats(
	quantity: number,
): Promise<SeatPreviewResult> {
	try {
		const organizationId = await ownedOrganizationId();
		if (!organizationId) {
			return { ok: false, message: "No active Cap Pro subscription found." };
		}
		if (quantity <= (await currentQuantity(organizationId))) {
			return { ok: false, message: "Choose more seats than you have now." };
		}
		const preview = await previewSeatChange(organizationId, quantity);
		return {
			ok: true,
			proratedAmount: preview.proratedAmount,
			recurringAmount: preview.recurringAmount,
			nextPaymentDate: preview.nextPaymentDate,
			currency: preview.currency,
		};
	} catch (error) {
		return {
			ok: false,
			message: errorMessage(error, "Couldn't price the extra seats."),
		};
	}
}

export async function addSeats(quantity: number): Promise<AddSeatsResult> {
	try {
		const organizationId = await ownedOrganizationId();
		if (!organizationId) {
			return { ok: false, message: "No active Cap Pro subscription found." };
		}
		if (quantity <= (await currentQuantity(organizationId))) {
			return { ok: false, message: "Choose more seats than you have now." };
		}
		const result = await updateSeatQuantity(organizationId, quantity);
		return { ok: true, quantity: result.newQuantity };
	} catch (error) {
		return {
			ok: false,
			message: errorMessage(error, "Couldn't add the seats."),
		};
	}
}
