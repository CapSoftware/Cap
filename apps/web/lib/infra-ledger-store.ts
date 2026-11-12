import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import { type LedgerRow, orderLedgerRows } from "@/lib/infra-ledger";

const EXPORT_BATCH_SIZE = 1_000;

const columns = {
	id: developerCreditTransactions.id,
	type: developerCreditTransactions.type,
	amountMicroCredits: developerCreditTransactions.amountMicroCredits,
	balanceAfterMicroCredits:
		developerCreditTransactions.balanceAfterMicroCredits,
	referenceId: developerCreditTransactions.referenceId,
	referenceType: developerCreditTransactions.referenceType,
	metadata: developerCreditTransactions.metadata,
	createdAt: developerCreditTransactions.createdAt,
};

const ofApp = (appId: string) => eq(developerCreditAccounts.appId, appId);

const appLedger = () =>
	db()
		.select(columns)
		.from(developerCreditTransactions)
		.innerJoin(
			developerCreditAccounts,
			eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
		);

const newestFirst = [
	desc(developerCreditTransactions.createdAt),
	desc(developerCreditTransactions.id),
] as const;

export async function listAppLedger(
	appId: string,
	{ limit, offset }: { limit: number; offset: number },
): Promise<{ rows: LedgerRow[]; hasMore: boolean }> {
	const rows = await appLedger()
		.where(ofApp(appId))
		.orderBy(...newestFirst)
		.limit(limit + 1)
		.offset(offset);
	return {
		rows: orderLedgerRows(rows.slice(0, limit)),
		hasMore: rows.length > limit,
	};
}

export async function countAppLedger(appId: string) {
	const [row] = await db()
		.select({ total: count() })
		.from(developerCreditTransactions)
		.innerJoin(
			developerCreditAccounts,
			eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
		)
		.where(ofApp(appId));
	return Number(row?.total ?? 0) || 0;
}

export async function* readAppLedger(
	appId: string,
	batchSize: number = EXPORT_BATCH_SIZE,
): AsyncGenerator<LedgerRow[]> {
	let cursor: { createdAt: Date; id: string } | null = null;
	for (;;) {
		const rows: LedgerRow[] = await appLedger()
			.where(
				and(
					ofApp(appId),
					cursor
						? or(
								lt(developerCreditTransactions.createdAt, cursor.createdAt),
								and(
									eq(developerCreditTransactions.createdAt, cursor.createdAt),
									lt(developerCreditTransactions.id, cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(...newestFirst)
			.limit(batchSize);
		const last = rows.at(-1);
		if (!last) return;
		yield orderLedgerRows(rows);
		if (rows.length < batchSize) return;
		cursor = { createdAt: last.createdAt, id: last.id };
	}
}
