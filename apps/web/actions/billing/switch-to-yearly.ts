"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { isProSubscription, stripe } from "@cap/utils";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { planPriceId } from "@/lib/checkout/plans";

export type YearlySwitchPreview =
	| {
			ok: true;
			quantity: number;
			dueToday: number;
			yearlyAmount: number;
			renewsOn: number;
			currency: string;
	  }
	| { ok: false; message: string };

export type YearlySwitchResult = { ok: true } | { ok: false; message: string };

const errorMessage = (error: unknown, fallback: string) =>
	error instanceof Error && error.message ? error.message : fallback;

async function switchableSubscription() {
	const user = await getCurrentUser();
	if (!user) throw new Error("Sign in to change your plan.");

	const [owner] = await db()
		.select({
			stripeSubscriptionId: users.stripeSubscriptionId,
			stripeCustomerId: users.stripeCustomerId,
		})
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	if (!owner?.stripeSubscriptionId || !owner.stripeCustomerId) {
		throw new Error("No active Cap Pro subscription found.");
	}

	const yearlyPriceId = planPriceId(
		"yearly",
		serverEnv().VERCEL_ENV === "production" ? "production" : "development",
	);
	const [subscription, yearlyPrice] = await Promise.all([
		stripe().subscriptions.retrieve(owner.stripeSubscriptionId),
		stripe().prices.retrieve(yearlyPriceId),
	]);
	const customerId =
		typeof subscription.customer === "string"
			? subscription.customer
			: subscription.customer.id;
	if (
		!isProSubscription(subscription) ||
		customerId !== owner.stripeCustomerId
	) {
		throw new Error("No active Cap Pro subscription found.");
	}
	if (subscription.status === "past_due") {
		throw new Error(
			"Your last payment didn't go through. Update your card in billing settings first.",
		);
	}
	if (subscription.status !== "active") {
		throw new Error("Only an active Cap Pro plan can switch to yearly.");
	}
	if (subscription.cancel_at_period_end) {
		throw new Error(
			"Your plan is set to end. Resume it in billing settings before switching to yearly.",
		);
	}

	const item = subscription.items.data[0];
	if (!item || subscription.items.data.length !== 1) {
		throw new Error(
			"This plan can't switch to yearly here. Email hello@cap.so and we'll do it for you.",
		);
	}
	if (item.price.recurring?.interval === "year") {
		throw new Error("You're already billed yearly.");
	}
	const itemProduct =
		typeof item.price.product === "string"
			? item.price.product
			: item.price.product.id;
	const yearlyProduct =
		typeof yearlyPrice.product === "string"
			? yearlyPrice.product
			: yearlyPrice.product.id;
	if (itemProduct !== yearlyProduct) {
		throw new Error(
			"This plan can't switch to yearly here. Email hello@cap.so and we'll do it for you.",
		);
	}

	return {
		customerId,
		subscription,
		item,
		yearlyPriceId,
		quantity: item.quantity ?? 1,
	};
}

export async function previewYearlySwitch(): Promise<YearlySwitchPreview> {
	try {
		const { customerId, subscription, item, yearlyPriceId, quantity } =
			await switchableSubscription();

		// Changing the interval moves the billing anchor to today, so Stripe's
		// upcoming invoice is the one charged on switching: a year at the new
		// price less credit for the unused part of the current month.
		const preview = await stripe().invoices.retrieveUpcoming({
			customer: customerId,
			subscription: subscription.id,
			subscription_items: [{ id: item.id, price: yearlyPriceId, quantity }],
			subscription_proration_behavior: "always_invoice",
		});
		const yearlyLines = preview.lines.data.filter((line) => !line.proration);
		const yearlyAmount = yearlyLines.reduce(
			(total, line) => total + line.amount,
			0,
		);
		const renewsOn = yearlyLines[0]?.period.end;
		if (!renewsOn) throw new Error("Couldn't price the yearly plan.");

		return {
			ok: true,
			quantity,
			dueToday: Math.max(0, preview.amount_due),
			yearlyAmount,
			renewsOn,
			currency: preview.currency,
		};
	} catch (error) {
		return {
			ok: false,
			message: errorMessage(error, "Couldn't price the yearly plan."),
		};
	}
}

export async function switchToYearly(
	quotedQuantity: number,
): Promise<YearlySwitchResult> {
	try {
		const { subscription, item, yearlyPriceId, quantity } =
			await switchableSubscription();
		// Stripe resets an item's quantity to 1 when its price changes without
		// one, and has no compare-and-set, so the switch must send a quantity.
		// Requiring the quoted one means seats added in another tab since the
		// quote are never written back over, and the charge matches the quote.
		if (quantity !== quotedQuantity) {
			return {
				ok: false,
				message:
					"Your seat count changed since this price was shown. Refresh the page to see the new yearly price.",
			};
		}

		// pending_if_incomplete leaves the monthly plan untouched when the
		// yearly charge fails or needs authentication, instead of switching
		// the plan and leaving an unpaid invoice behind.
		const updated = await stripe().subscriptions.update(subscription.id, {
			items: [{ id: item.id, price: yearlyPriceId, quantity }],
			proration_behavior: "always_invoice",
			payment_behavior: "pending_if_incomplete",
		});
		if (updated.pending_update) {
			return {
				ok: false,
				message:
					"Your card was declined for the yearly charge, so you're still on monthly. Update your card in billing settings and try again.",
			};
		}

		revalidatePath("/dashboard/settings/organization");
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			message: errorMessage(error, "Couldn't switch your plan to yearly."),
		};
	}
}
