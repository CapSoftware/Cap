import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type DeveloperCreditReferenceType,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, eq, sql } from "drizzle-orm";

const MICRO_CREDITS_PER_DOLLAR = 100_000;

export async function addCreditsToAccount({
	accountId,
	amountCents,
	referenceId,
	referenceType,
	metadata,
}: {
	accountId: string;
	amountCents: number;
	referenceId?: string;
	referenceType?: DeveloperCreditReferenceType;
	metadata?: Record<string, unknown>;
}): Promise<number> {
	const microCreditsToAdd = Math.floor(
		(amountCents / 100) * MICRO_CREDITS_PER_DOLLAR,
	);

	const newBalance = await db().transaction(async (tx) => {
		if (referenceId && referenceType) {
			const [account] = await tx
				.select({
					balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
				})
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, accountId))
				.limit(1)
				.for("update");

			if (!account) throw new Error(`Credit account not found: ${accountId}`);

			const [existing] = await tx
				.select({ id: developerCreditTransactions.id })
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						eq(developerCreditTransactions.referenceId, referenceId),
						eq(developerCreditTransactions.referenceType, referenceType),
					),
				)
				.limit(1);

			if (existing) return account.balanceMicroCredits;
		}

		await tx
			.update(developerCreditAccounts)
			.set({
				balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} + ${microCreditsToAdd}`,
			})
			.where(eq(developerCreditAccounts.id, accountId));

		const [updated] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, accountId))
			.limit(1);

		if (!updated) {
			throw new Error(`Credit account not found: ${accountId}`);
		}

		await tx.insert(developerCreditTransactions).values({
			id: nanoId(),
			accountId,
			type: "topup",
			amountMicroCredits: microCreditsToAdd,
			balanceAfterMicroCredits: updated.balanceMicroCredits,
			referenceId,
			referenceType,
			metadata: metadata ?? { amountCents },
		});

		return updated.balanceMicroCredits;
	});

	return newBalance;
}
