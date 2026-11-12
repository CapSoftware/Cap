import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type DeveloperCreditReferenceType,
	type DeveloperCreditTransactionType,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import { heldTranscriptMicroCredits } from "@/lib/infra-balance";

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

type DeveloperCreditTransaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export type DeveloperUsageDebit =
	| { state: "debited"; chargedMicroCredits: number; balanceAfter: number }
	| { state: "already_paid" }
	| { state: "no_account" }
	| { state: "insufficient" };

const affectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function debitDeveloperUsage(
	tx: DeveloperCreditTransaction,
	input: {
		appId: string;
		microCredits: number;
		type: DeveloperCreditTransactionType;
		referenceId: string;
		referenceType: DeveloperCreditReferenceType;
		metadata?: Record<string, unknown>;
		settlesTranscriptId?: string;
	},
): Promise<DeveloperUsageDebit> {
	const [account] = await tx
		.select({
			id: developerCreditAccounts.id,
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, input.appId))
		.limit(1)
		.for("update");

	if (!account) return { state: "no_account" };

	const [paid] = await tx
		.select({
			total: sql<number>`COALESCE(SUM(-${developerCreditTransactions.amountMicroCredits}), 0)`,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, account.id),
				eq(developerCreditTransactions.referenceId, input.referenceId),
				eq(developerCreditTransactions.referenceType, input.referenceType),
				eq(developerCreditTransactions.type, input.type),
			),
		);

	const remaining = Math.floor(input.microCredits) - Number(paid?.total ?? 0);
	if (remaining <= 0) return { state: "already_paid" };

	const heldForOthers = await heldTranscriptMicroCredits(
		tx,
		input.appId,
		input.settlesTranscriptId ?? null,
	);

	const result = await tx
		.update(developerCreditAccounts)
		.set({
			balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${remaining}`,
		})
		.where(
			and(
				eq(developerCreditAccounts.id, account.id),
				sql`${developerCreditAccounts.balanceMicroCredits} >= ${remaining + heldForOthers}`,
			),
		);

	if (affectedRows(result) === 0) return { state: "insufficient" };

	const [updated] = await tx
		.select({
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.id, account.id))
		.limit(1);

	if (!updated) throw new Error(`Credit account not found: ${account.id}`);

	await tx.insert(developerCreditTransactions).values({
		id: nanoId(),
		accountId: account.id,
		type: input.type,
		amountMicroCredits: -remaining,
		balanceAfterMicroCredits: updated.balanceMicroCredits,
		referenceId: input.referenceId,
		referenceType: input.referenceType,
		metadata: input.metadata,
	});

	return {
		state: "debited",
		chargedMicroCredits: remaining,
		balanceAfter: updated.balanceMicroCredits,
	};
}
