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
import { and, count, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import {
	AVAILABLE_AFTER_FIELD,
	heldTranscriptMicroCredits,
} from "@/lib/infra-balance";
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

export type ProCreditSubscription = {
	id: string;
	seats: number;
	payerId: User.UserId;
};

export type ProCreditPayer =
	| { state: "refused"; message: string }
	| { state: "ok"; subscription: ProCreditSubscription | null };

export const PRO_CREDIT_NOT_PRO_MESSAGE = "This credit comes with Cap Pro.";
export const PRO_CREDIT_CLAIMED_MESSAGE =
	"This month's credit is already claimed. It is one per account, not one per app.";
export const PRO_CREDIT_SEATS_CLAIMED_MESSAGE =
	"This month's Cap Pro credits for your team are all claimed. There is one for each paid seat.";
export const PRO_CREDIT_CHECK_FAILED_MESSAGE =
	"Could not check your Cap Pro subscription. Try again in a moment.";

const STRIPE_PAID_STATUSES = new Set<string>(["active", "past_due"]);

async function payerOf(customer: Stripe.Subscription["customer"]) {
	if (typeof customer === "string" || customer.deleted) return null;
	const claimedId = customer.metadata?.userId;
	if (claimedId) {
		const [byId] = await db()
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, claimedId as User.UserId))
			.limit(1);
		if (byId) return byId.id;
	}
	if (!customer.email) return null;
	const [byEmail] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, customer.email))
		.limit(1);
	return byEmail?.id ?? null;
}

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
		subscription = await stripe().subscriptions.retrieve(subscriptionId, {
			expand: ["customer"],
		});
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

	const payerId = ownSubscriptionId
		? user.id
		: await payerOf(subscription.customer);
	if (!payerId) {
		return { state: "refused", message: PRO_CREDIT_CHECK_FAILED_MESSAGE };
	}

	return {
		state: "ok",
		subscription: {
			id: subscription.id,
			seats: subscription.items.data.reduce(
				(total, item) => total + (item.quantity || 1),
				0,
			),
			payerId,
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
	| { claimed: true; balanceMicroCredits: number }
	| { claimed: false; reason: "already_claimed" | "seats_claimed" }
> {
	const period = proCreditPeriod(now);

	return db().transaction(async (tx) => {
		const lockedUserIds =
			subscription && subscription.payerId !== userId
				? [subscription.payerId, userId]
				: [userId];
		for (const lockedUserId of lockedUserIds) {
			await tx
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, lockedUserId))
				.limit(1)
				.for("update");
		}

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

		if (existing) {
			return { claimed: false as const, reason: "already_claimed" as const };
		}

		if (subscription) {
			const [claims] = await tx
				.select({ total: count() })
				.from(developerCreditAccounts)
				.innerJoin(
					developerCreditTransactions,
					eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
				)
				.where(
					and(
						eq(developerCreditTransactions.referenceType, REFERENCE_TYPE),
						eq(developerCreditTransactions.referenceId, period),
						sql`JSON_UNQUOTE(JSON_EXTRACT(${developerCreditTransactions.metadata}, '$.subscriptionId')) = ${subscription.id}`,
					),
				);
			if (Number(claims?.total ?? 0) >= subscription.seats) {
				return { claimed: false as const, reason: "seats_claimed" as const };
			}
		}

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
				appId: developerCreditAccounts.appId,
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
			metadata: {
				...(subscription
					? {
							period,
							subscriptionId: subscription.id,
							seats: subscription.seats,
						}
					: { period }),
				[AVAILABLE_AFTER_FIELD]:
					updated.balanceMicroCredits -
					(await heldTranscriptMicroCredits(tx, updated.appId)),
			},
		});

		return {
			claimed: true as const,
			balanceMicroCredits: updated.balanceMicroCredits,
		};
	});
}
