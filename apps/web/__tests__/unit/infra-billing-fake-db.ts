import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
	developerTranscripts,
	developerVideos,
} from "@cap/database/schema";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();

export type LedgerRow = {
	id: string;
	accountId: string;
	type: string;
	amountMicroCredits: number;
	balanceAfterMicroCredits: number;
	referenceId?: string | null;
	referenceType?: string | null;
	metadata?: Record<string, unknown> | null;
	createdAt: Date;
};

export type SnapshotRow = {
	snapshotDate: string;
	totalDurationMinutes: number;
	videoCount: number;
	microCreditsCharged: number;
	processedAt?: Date | null;
};

export type VideoGroup = {
	videoId?: string;
	appId: string;
	width: number | null;
	height: number | null;
	seconds: number;
	count: number;
	status?: string;
	maxResolutionTier?: string | null;
};

const freshAccount = () => ({
	id: "account-1",
	appId: "app-1",
	exists: true,
	balanceMicroCredits: 0,
	stripeCustomerId: null as string | null,
	stripePaymentMethodId: null as string | null,
	autoTopUpEnabled: false,
	autoTopUpThresholdMicroCredits: 0,
	autoTopUpAmountCents: 0,
	email: "richie@cap.so",
});

export const ledger = {
	now: new Date("2026-11-11T06:41:00Z"),
	account: freshAccount(),
	rows: [] as LedgerRow[],
	snapshots: [] as SnapshotRow[],
	videos: [] as VideoGroup[],
	heldMicroCredits: 0,
};

export function resetLedger() {
	ledger.now = new Date("2026-11-11T06:41:00Z");
	ledger.account = freshAccount();
	ledger.rows = [];
	ledger.snapshots = [];
	ledger.videos = [];
	ledger.heldMicroCredits = 0;
}

export function advanceDays(days: number) {
	ledger.now = new Date(ledger.now.getTime() + days * 24 * 60 * 60 * 1000);
}

export const dateKey = () => ledger.now.toISOString().slice(0, 10);

export const storageRows = () =>
	ledger.rows.filter((row) => row.type === "storage_daily");

type Query = {
	fields: Record<string, unknown>;
	table: unknown;
	where: SQL | undefined;
};

const asTime = (value: unknown) => {
	if (value instanceof Date) return value.getTime();
	const text = String(value);
	return new Date(
		/Z$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`,
	).getTime();
};

const newestFirst = (rows: LedgerRow[]) =>
	[...rows].sort(
		(a, b) =>
			b.createdAt.getTime() - a.createdAt.getTime() ||
			ledger.rows.indexOf(b) - ledger.rows.indexOf(a),
	);

function runSelect(query: Query): Record<string, unknown>[] {
	const keys = Object.keys(query.fields).sort().join(",");
	const rendered = query.where
		? dialect.sqlToQuery(query.where)
		: { sql: "", params: [] as unknown[] };

	if (query.table === developerCreditAccounts) {
		const { exists, ...account } = ledger.account;
		if (!exists) return [];
		if (
			rendered.sql.includes("autoTopUpThresholdMicroCredits") &&
			keys === "id" &&
			!(
				account.autoTopUpEnabled &&
				account.stripePaymentMethodId &&
				account.balanceMicroCredits < account.autoTopUpThresholdMicroCredits
			)
		) {
			return [];
		}
		return [account];
	}

	if (query.table === developerCreditTransactions) {
		if (keys === "createdAt,metadata") {
			return newestFirst(storageRows()).slice(0, 1);
		}
		if (keys === "metadata") {
			const since = asTime(rendered.params.at(-1));
			return storageRows().filter((row) => row.createdAt.getTime() >= since);
		}
		if (keys === "createdAt,metadata,type") {
			const types = rendered.params.slice(1);
			return newestFirst(
				ledger.rows.filter((row) => types.includes(row.referenceType)),
			).slice(0, 1);
		}
		if (keys === "id" && rendered.sql.includes("balanceAfterMicroCredits")) {
			const [, since, , owed] = rendered.params;
			return ledger.rows.filter(
				(row) =>
					row.createdAt.getTime() >= asTime(since) &&
					row.amountMicroCredits > 0 &&
					row.balanceAfterMicroCredits >= Number(owed),
			);
		}
		if (keys === "id") {
			const [, referenceId, ...referenceTypes] = rendered.params;
			return ledger.rows.filter(
				(row) =>
					row.referenceId === referenceId &&
					referenceTypes.includes(row.referenceType),
			);
		}
		if (keys === "accountId") {
			const [, referenceId, referenceType] = rendered.params.slice(-3);
			return ledger.rows.filter(
				(row) =>
					row.referenceId === referenceId &&
					row.referenceType === referenceType,
			);
		}
	}

	if (query.table === developerTranscripts) {
		return [{ total: ledger.heldMicroCredits }];
	}

	if (query.table === developerDailyStorageSnapshots) {
		return ledger.snapshots.filter((snapshot) =>
			rendered.params.includes(snapshot.snapshotDate),
		);
	}

	if (query.table === developerVideos) {
		return rendered.sql.includes("<> ?")
			? ledger.videos.filter(
					(video) => !video.videoId || !rendered.params.includes(video.videoId),
				)
			: ledger.videos;
	}

	throw new Error(`Unexpected select: ${keys}`);
}

function select(fields: Record<string, unknown>) {
	const query: Query = { fields, table: null, where: undefined };
	const chain = {
		from(table: unknown) {
			query.table = table;
			return chain;
		},
		innerJoin: () => chain,
		where(condition: SQL | undefined) {
			query.where = condition;
			const rows = Promise.resolve().then(() => runSelect(query));
			const result = Object.assign(rows, {
				orderBy: () => result,
				groupBy: () => result,
				limit: () => result,
				for: () => result,
			});
			return result;
		},
	};
	return chain;
}

function update(table: unknown) {
	return {
		set(values: Record<string, unknown>) {
			return {
				async where() {
					if (table !== developerCreditAccounts) return [{ affectedRows: 0 }];
					const { balanceMicroCredits, ...rest } = values;
					if (balanceMicroCredits !== undefined) {
						const rendered = dialect.sqlToQuery(balanceMicroCredits as SQL);
						const amount = Number(rendered.params.at(-1));
						ledger.account.balanceMicroCredits += rendered.sql.includes("-")
							? -amount
							: amount;
					}
					Object.assign(ledger.account, rest);
					return [{ affectedRows: 1 }];
				},
			};
		},
	};
}

function insert(table: unknown) {
	return {
		values(values: Record<string, unknown>) {
			const write = () => {
				if (table === developerCreditTransactions) {
					ledger.rows.push({
						...(values as Omit<LedgerRow, "createdAt">),
						createdAt: new Date(ledger.now),
					});
				}
			};
			return Object.assign(Promise.resolve().then(write), {
				onDuplicateKeyUpdate: async () => {
					if (table !== developerDailyStorageSnapshots) return;
					const row = values as SnapshotRow;
					ledger.snapshots = [
						...ledger.snapshots.filter(
							(snapshot) => snapshot.snapshotDate !== row.snapshotDate,
						),
						{
							snapshotDate: row.snapshotDate,
							totalDurationMinutes: row.totalDurationMinutes,
							videoCount: row.videoCount,
							microCreditsCharged: row.microCreditsCharged,
							processedAt: row.processedAt ?? null,
						},
					];
				},
			});
		},
	};
}

type FakeDb = {
	select: typeof select;
	update: typeof update;
	insert: typeof insert;
	transaction: <T>(run: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

export const fakeDb: FakeDb = {
	select,
	update,
	insert,
	transaction: (run) => run(fakeDb),
};
