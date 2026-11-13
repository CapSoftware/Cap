import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, asc, desc, eq, gt, gte, lt, lte, or, sql } from "drizzle-orm";
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

const ofApp = (appId: string) =>
	and(
		eq(developerCreditAccounts.appId, appId),
		sql`${developerCreditTransactions.type} <> 'topup_pending'`,
	);

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

const oldestFirst = [
	asc(developerCreditTransactions.createdAt),
	asc(developerCreditTransactions.id),
] as const;

export type LedgerCursor = { createdAt: Date; id: string };

const CURSOR_PATTERN = /^(\d{1,15})\.([0-9a-z]{1,32})$/;

export function formatLedgerCursor(row: LedgerCursor) {
	return `${new Date(row.createdAt).getTime()}.${row.id}`;
}

export function parseLedgerCursor(
	raw: string | null | undefined,
): LedgerCursor | null {
	const match = raw ? CURSOR_PATTERN.exec(raw) : null;
	if (!match?.[1] || !match[2]) return null;
	const createdAt = new Date(Number(match[1]));
	return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: match[2] };
}

const olderThan = (cursor: LedgerCursor) =>
	or(
		lt(developerCreditTransactions.createdAt, cursor.createdAt),
		and(
			eq(developerCreditTransactions.createdAt, cursor.createdAt),
			lt(developerCreditTransactions.id, cursor.id),
		),
	);

const newerThan = (cursor: LedgerCursor) =>
	or(
		gt(developerCreditTransactions.createdAt, cursor.createdAt),
		and(
			eq(developerCreditTransactions.createdAt, cursor.createdAt),
			gt(developerCreditTransactions.id, cursor.id),
		),
	);

export async function listAppLedger(
	appId: string,
	{ limit, offset }: { limit: number; offset: number },
): Promise<{ rows: LedgerRow[]; hasMore: boolean }> {
	const rows = await appLedger()
		.where(ofApp(appId))
		.orderBy(...newestFirst)
		.limit(limit + 1)
		.offset(offset);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	const newest = page[0];
	const oldest = page.at(-1);
	if (!newest || !oldest || (offset === 0 && !hasMore)) {
		return { rows: orderLedgerRows(page), hasMore };
	}

	const seconds: LedgerRow[] = await appLedger()
		.where(
			and(
				ofApp(appId),
				gte(developerCreditTransactions.createdAt, oldest.createdAt),
				lte(developerCreditTransactions.createdAt, newest.createdAt),
			),
		)
		.orderBy(...newestFirst);
	const skipped = Math.max(
		0,
		seconds.findIndex((row) => row.id === newest.id),
	);
	return {
		rows: orderLedgerRows(seconds).slice(skipped, skipped + limit),
		hasMore,
	};
}

export type LedgerPage = {
	rows: LedgerRow[];
	newer: string | null;
	older: string | null;
};

export async function listAppLedgerPage(
	appId: string,
	{
		limit,
		before = null,
		after = null,
	}: {
		limit: number;
		before?: LedgerCursor | null;
		after?: LedgerCursor | null;
	},
): Promise<LedgerPage> {
	if (after) {
		const fetched: LedgerRow[] = await appLedger()
			.where(and(ofApp(appId), newerThan(after)))
			.orderBy(...oldestFirst)
			.limit(limit + 1);
		if (fetched.length >= limit) {
			const page = fetched.slice(0, limit).reverse();
			const newest = page[0];
			const oldest = page.at(-1);
			return {
				rows: orderLedgerRows(page),
				newer:
					fetched.length > limit && newest ? formatLedgerCursor(newest) : null,
				older: oldest ? formatLedgerCursor(oldest) : null,
			};
		}
	}

	const cursor = after ? null : before;
	const fetched: LedgerRow[] = await appLedger()
		.where(and(ofApp(appId), cursor ? olderThan(cursor) : undefined))
		.orderBy(...newestFirst)
		.limit(limit + 1);
	const page = fetched.slice(0, limit);
	const oldest = page.at(-1);
	return {
		rows: orderLedgerRows(page),
		newer: cursor ? formatLedgerCursor(page[0] ?? cursor) : null,
		older: fetched.length > limit && oldest ? formatLedgerCursor(oldest) : null,
	};
}

export async function* readAppLedger(
	appId: string,
	batchSize: number = EXPORT_BATCH_SIZE,
): AsyncGenerator<LedgerRow[]> {
	let cursor: LedgerCursor | null = null;
	for (;;) {
		const rows: LedgerRow[] = await appLedger()
			.where(and(ofApp(appId), cursor ? olderThan(cursor) : undefined))
			.orderBy(...newestFirst)
			.limit(batchSize);
		const last = rows.at(-1);
		if (!last) return;
		if (rows.length < batchSize) {
			yield orderLedgerRows(rows);
			return;
		}
		const lastSecond = new Date(last.createdAt).getTime();
		const restOfSecond: LedgerRow[] = await appLedger()
			.where(
				and(
					ofApp(appId),
					eq(developerCreditTransactions.createdAt, last.createdAt),
				),
			)
			.orderBy(...newestFirst);
		yield orderLedgerRows([
			...rows.filter((row) => new Date(row.createdAt).getTime() !== lastSecond),
			...restOfSecond,
		]);
		cursor = { createdAt: last.createdAt, id: "" };
	}
}
