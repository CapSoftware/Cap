import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	users,
} from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";

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

export async function claimProMonthlyCredit({
	userId,
	accountId,
	now,
}: {
	userId: User.UserId;
	accountId: string;
	now: Date;
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
			metadata: { period },
		});

		return {
			claimed: true as const,
			balanceMicroCredits: updated.balanceMicroCredits,
		};
	});
}
