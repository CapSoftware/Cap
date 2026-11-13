import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	users,
} from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import type { User } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import {
	PAID_PRO_STATUSES,
	PRO_CREDIT_TRIAL_MESSAGE,
} from "@/lib/infra-pro-credit-eligibility";

export const PRO_MONTHLY_CREDIT_DOLLARS = 5;
export const PRO_MONTHLY_CREDIT_MICRO_CREDITS =
	PRO_MONTHLY_CREDIT_DOLLARS * MICRO_CREDITS_PER_DOLLAR;

const REFERENCE_TYPE = "pro_monthly_credit" as const;

export function proCreditPeriod(now: Date) {
	return now.toISOString().slice(0, 7);
}

export function nextProCreditDate(now: Date) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function hasClaimedProCredit(userId: User.UserId, now: Date) {
	const [existing] = await db()
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditTransactions)
		.innerJoin(
			developerCreditAccounts,
			eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
		)
		.where(
			and(
				eq(developerCreditAccounts.ownerId, userId),
				eq(developerCreditTransactions.referenceType, REFERENCE_TYPE),
				eq(developerCreditTransactions.referenceId, proCreditPeriod(now)),
			),
		)
		.limit(1);
	return !!existing;
}

export type ProCreditSubscription = { id: string; seats: number };

export type ProCreditPayer =
	| { state: "refused"; message: string }
	| { state: "ok"; subscription: ProCreditSubscription | null };

export const PRO_CREDIT_NOT_PRO_MESSAGE = "This credit comes with Cap Pro.";
export const PRO_CREDIT_CLAIMED_MESSAGE =
	"This month's credit is already claimed. It is one per account, not one per app.";
export const PRO_CREDIT_CHECK_FAILED_MESSAGE =
	"Could not check your Cap Pro subscription. Try again in a moment.";

const STRIPE_PAID_STATUSES = new Set<string>(["active", "past_due"]);

export async function proCreditPayer(user: {
	id: User.UserId;
	stripeSubscriptionId?: string | null;
	stripeSubscriptionStatus?: string | null;
	thirdPartyStripeSubscriptionId?: string | null;
}): Promise<ProCreditPayer> {
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return { state: "ok", subscription: null };

	const ownSubscriptionId =
		user.stripeSubscriptionId &&
		PAID_PRO_STATUSES.has(user.stripeSubscriptionStatus ?? "")
			? user.stripeSubscriptionId
			: null;
	const subscriptionId =
		ownSubscriptionId ?? user.thirdPartyStripeSubscriptionId ?? null;
	if (!subscriptionId) return { state: "ok", subscription: null };

	let subscription: Stripe.Subscription;
	try {
		subscription = await stripe().subscriptions.retrieve(subscriptionId);
	} catch (error) {
		console.error("[infra-billing] Could not read a Cap Pro subscription", {
			userId: user.id,
			error,
		});
		return { state: "refused", message: PRO_CREDIT_CHECK_FAILED_MESSAGE };
	}

	if (subscription.status === "trialing") {
		return { state: "refused", message: PRO_CREDIT_TRIAL_MESSAGE };
	}
	if (!STRIPE_PAID_STATUSES.has(subscription.status)) {
		return { state: "refused", message: PRO_CREDIT_NOT_PRO_MESSAGE };
	}

	return {
		state: "ok",
		subscription: {
			id: subscription.id,
			seats: subscription.items.data.reduce(
				(total, item) => total + (item.quantity || 1),
				0,
			),
		},
	};
}

export async function claimProMonthlyCredit({
	userId,
	accountId,
	now,
	subscription = null,
}: {
	userId: User.UserId;
	accountId: string;
	now: Date;
	subscription?: ProCreditSubscription | null;
}): Promise<
	{ claimed: true; balanceMicroCredits: number } | { claimed: false }
> {
	const period = proCreditPeriod(now);

	return db().transaction(async (tx) => {
		await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1)
			.for("update");

		const [existing] = await tx
			.select({ id: developerCreditTransactions.id })
			.from(developerCreditTransactions)
			.innerJoin(
				developerCreditAccounts,
				eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
			)
			.where(
				and(
					eq(developerCreditAccounts.ownerId, userId),
					eq(developerCreditTransactions.referenceType, REFERENCE_TYPE),
					eq(developerCreditTransactions.referenceId, period),
				),
			)
			.limit(1);

		if (existing) return { claimed: false as const };

		await tx
			.update(developerCreditAccounts)
			.set({
				balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} + ${PRO_MONTHLY_CREDIT_MICRO_CREDITS}`,
			})
			.where(
				and(
					eq(developerCreditAccounts.id, accountId),
					eq(developerCreditAccounts.ownerId, userId),
				),
			);

		const [updated] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(
				and(
					eq(developerCreditAccounts.id, accountId),
					eq(developerCreditAccounts.ownerId, userId),
				),
			)
			.limit(1);

		if (!updated) throw new Error("Credit account not found");

		await tx.insert(developerCreditTransactions).values({
			id: nanoId(),
			accountId,
			type: "pro_credit",
			amountMicroCredits: PRO_MONTHLY_CREDIT_MICRO_CREDITS,
			balanceAfterMicroCredits: updated.balanceMicroCredits,
			referenceId: period,
			referenceType: REFERENCE_TYPE,
			metadata: subscription
				? { period, subscriptionId: subscription.id, seats: subscription.seats }
				: { period },
		});

		return {
			claimed: true as const,
			balanceMicroCredits: updated.balanceMicroCredits,
		};
	});
}
