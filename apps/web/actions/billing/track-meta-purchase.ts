"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { stripe } from "@cap/utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

export async function getPurchaseForMeta({
	sessionId,
}: {
	sessionId?: string | null;
}): Promise<{
	shouldTrack: boolean;
	value?: number;
	currency?: string;
	eventId?: string;
}> {
	const user = await getCurrentUser();
	if (!user) {
		return { shouldTrack: false };
	}

	let subscriptionId: string | undefined;
	let customerId: string | undefined;
	let eventId: string | undefined;

	try {
		if (sessionId) {
			const session = await stripe().checkout.sessions.retrieve(sessionId);
			if (!session || session.mode !== "subscription") {
				return { shouldTrack: false };
			}

			eventId = session.id;
			customerId = (session.customer as string) || undefined;

			if (
				user.stripeCustomerId &&
				customerId &&
				user.stripeCustomerId !== customerId
			) {
				return { shouldTrack: false };
			}

			if (!user.stripeCustomerId && customerId) {
				const customer = await stripe().customers.retrieve(customerId);
				let matches = false;
				if (
					"metadata" in customer &&
					customer.metadata &&
					(customer.metadata as Record<string, string | undefined>).userId ===
						user.id
				) {
					matches = true;
				} else if (
					"email" in customer &&
					customer.email &&
					customer.email === user.email
				) {
					matches = true;
				}
				if (!matches) {
					return { shouldTrack: false };
				}
				await db()
					.update(users)
					.set({ stripeCustomerId: customer.id })
					.where(eq(users.id, user.id));
			}

			if (session.subscription) {
				subscriptionId = String(session.subscription);
			}
		}

		if (!subscriptionId) {
			if (user.stripeSubscriptionId) {
				subscriptionId = user.stripeSubscriptionId;
			} else if (user.stripeCustomerId) {
				const subs = await stripe().subscriptions.list({
					customer: user.stripeCustomerId,
					status: "all",
					limit: 1,
				});
				if (subs.data[0]) subscriptionId = subs.data[0].id;
			}
		}

		if (!subscriptionId) {
			return { shouldTrack: false };
		}

		const subscription = await stripe().subscriptions.retrieve(subscriptionId);
		const alreadyTracked =
			(subscription.metadata &&
				(subscription.metadata as Record<string, string | undefined>)
					.meta_purchase_tracked === "true") ||
			false;
		if (alreadyTracked) {
			return { shouldTrack: false };
		}

		const currency = subscription.items.data[0]?.price?.currency?.toUpperCase();
		const amountCents = subscription.items.data.reduce((acc, item) => {
			const unit = item.price?.unit_amount ?? 0;
			const qty = item.quantity ?? 1;
			return acc + unit * qty;
		}, 0);
		const value = amountCents / 100;

		await stripe().subscriptions.update(subscription.id, {
			metadata: {
				...(subscription.metadata || {}),
				meta_purchase_tracked: "true",
			} as Stripe.MetadataParam,
		});

		return { shouldTrack: true, value, currency, eventId };
	} catch {
		return { shouldTrack: false };
	}
}
