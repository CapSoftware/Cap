import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
	developerTranscripts,
	developerVideos,
} from "@cap/database/schema";
import { type SQL, sql } from "drizzle-orm";
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
	dailySeconds?: number;
	dailyCount?: number;
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
	appDeletedAt: null as Date | null,
});

export const ledger = {
	now: new Date("2026-11-11T06:41:00Z"),
	account: freshAccount(),
	rows: [] as LedgerRow[],
	snapshots: [] as SnapshotRow[],
	videos: [] as VideoGroup[],
	heldMicroCredits: 0,
	appDeletedBeforeLock: false,
};

export function resetLedger() {
	ledger.now = new Date("2026-11-11T06:41:00Z");
	ledger.account = freshAccount();
	ledger.rows = [];
	ledger.snapshots = [];
	ledger.appDeletedBeforeLock = false;
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

const availableAfter = (row: LedgerRow) =>
	Number(
		(row.metadata as { availableAfterMicroCredits?: number } | null | undefined)
			?.availableAfterMicroCredits ?? row.balanceAfterMicroCredits,
	);

const newestFirst = (rows: LedgerRow[]) =>
	[...rows].sort(
		(a, b) =>
			b.createdAt.getTime() - a.createdAt.getTime() ||
			ledger.rows.indexOf(b) - ledger.rows.indexOf(a),
	);

const byId = (a: LedgerRow, b: LedgerRow) =>
	a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

const latestWritten = (rows: LedgerRow[]) =>
	[...rows].sort(
		(a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byId(a, b),
	);

const latestStorageDayRows = () => {
	const days = storageRows().filter(
		(row) => row.referenceType === "storage_day" && row.referenceId,
	);
	const latestDay = days
		.map((row) => String(row.referenceId))
		.sort()
		.at(-1);
	return days.filter((row) => row.referenceId === latestDay).sort(byId);
};

const HOUR_MS = 60 * 60 * 1000;

function autoTopUpWaits() {
	const now = ledger.now.getTime();
	const of = (type: string, referenceType: string) =>
		ledger.rows.filter(
			(row) => row.type === type && row.referenceType === referenceType,
		);
	const settledIds = new Set(
		ledger.rows
			.filter(
				(row) =>
					row.referenceType === "auto_top_up" ||
					row.referenceType === "auto_top_up_failed",
			)
			.map((row) => row.referenceId),
	);
	const topUps = of("topup", "auto_top_up");
	return {
		pending: of("topup_pending", "auto_top_up_pending").some(
			(row) =>
				row.createdAt.getTime() > now - 72 * HOUR_MS &&
				!String(row.referenceId).startsWith("infra-auto-top-up:") &&
				!settledIds.has(row.referenceId),
		),
		decline: of("topup_failed", "auto_top_up_failed").some(
			(row) =>
				row.createdAt.getTime() > now - 24 * HOUR_MS &&
				!topUps.some((topUp) => topUp.createdAt > row.createdAt),
		),
		limit:
			topUps.filter((row) => row.createdAt.getTime() > now - 24 * HOUR_MS)
				.length >= 10,
		owner:
			ledger.rows
				.filter(
					(row) =>
						!String(row.referenceId).startsWith("infra-auto-top-up:") &&
						((row.type === "topup" &&
							row.referenceType === "auto_top_up" &&
							row.createdAt.getTime() > now - 24 * HOUR_MS) ||
							(row.type === "topup_pending" &&
								row.referenceType === "auto_top_up_pending" &&
								!settledIds.has(row.referenceId))),
				)
				.reduce(
					(total, row) =>
						total +
						(row.type === "topup"
							? row.amountMicroCredits
							: Number(row.metadata?.amountCents ?? 0) * 1000),
					0,
				) +
				Number(
					ledger.rows.find(
						(row) =>
							row.type === "topup_pending" &&
							String(row.referenceId).startsWith("infra-auto-top-up:"),
					)?.metadata?.amountCents ?? ledger.account.autoTopUpAmountCents,
				) *
					1000 >
			100_000_000,
	};
}

function runSelect(query: Query): Record<string, unknown>[] {
	const keys = Object.keys(query.fields).sort().join(",");
	const rendered = query.where
		? dialect.sqlToQuery(query.where)
		: { sql: "", params: [] as unknown[] };

	if (query.table === developerCreditAccounts) {
		const { exists, ...account } = ledger.account;
		if (!exists) return [];
		if (
			keys ===
			"amountCents,balanceMicroCredits,customerId,declineWait,enabled,id,limitWait,ownerWait,paymentMethodId,pendingWait,thresholdMicroCredits"
		) {
			if (rendered.params.at(-1) !== account.id) return [];
			const waits = autoTopUpWaits();
			return [
				{
					id: account.id,
					enabled: account.autoTopUpEnabled,
					thresholdMicroCredits: account.autoTopUpThresholdMicroCredits,
					amountCents: account.autoTopUpAmountCents,
					customerId: account.stripeCustomerId,
					paymentMethodId: account.stripePaymentMethodId,
					balanceMicroCredits: account.balanceMicroCredits,
					pendingWait: Number(waits.pending),
					declineWait: Number(waits.decline),
					limitWait: Number(waits.limit),
					ownerWait: Number(waits.owner),
				},
			];
		}
		if (keys === "attemptKey,id") {
			const waits = autoTopUpWaits();
			const attempts = ledger.rows
				.filter((row) =>
					["auto_top_up", "auto_top_up_failed", "auto_top_up_pending"].includes(
						String(row.referenceType),
					),
				)
				.map((row) => row.createdAt.getTime());
			const lastAttempt = attempts.length > 0 ? Math.max(...attempts) : null;
			const due =
				account.autoTopUpEnabled &&
				account.stripePaymentMethodId &&
				account.balanceMicroCredits <
					account.autoTopUpThresholdMicroCredits + ledger.heldMicroCredits &&
				!waits.pending &&
				!waits.decline &&
				!waits.limit &&
				!waits.owner;
			return due
				? [
						{
							id: account.id,
							attemptKey:
								lastAttempt === null
									? "1970-01-01 00:00:00"
									: new Date(lastAttempt)
											.toISOString()
											.slice(0, 19)
											.replace("T", " "),
						},
					]
				: [];
		}
		if (
			keys === "id" &&
			/`id` = \?$/.test(rendered.sql) &&
			rendered.params[0] !== account.id
		) {
			return [];
		}
		if (
			rendered.sql.includes("autoTopUpThresholdMicroCredits") &&
			keys === "id" &&
			!(
				account.autoTopUpEnabled &&
				account.stripePaymentMethodId &&
				account.balanceMicroCredits <
					account.autoTopUpThresholdMicroCredits + ledger.heldMicroCredits
			)
		) {
			return [];
		}
		if ("heldMicroCredits" in query.fields) {
			const [dispute] = latestWritten(
				ledger.rows.filter(
					(row) =>
						row.type === "adjustment" &&
						["stripe_dispute", "manual"].includes(String(row.referenceType)),
				),
			);
			return [
				{
					...account,
					heldMicroCredits: ledger.heldMicroCredits,
					disputeType: dispute?.referenceType ?? null,
					disputeCreatedAt: dispute?.createdAt ?? null,
				},
			];
		}
		return [account];
	}

	if (query.table === developerCreditTransactions) {
		if (keys === "createdAt") {
			const type = rendered.params[1];
			return latestWritten(
				ledger.rows.filter((row) => row.type === type),
			).slice(0, 1);
		}
		if (keys === "createdAt,id,metadata") {
			if (
				rendered.sql.includes(
					"`developer_credit_transactions`.`referenceId` <= ?",
				)
			) {
				return latestStorageDayRows().slice(0, 1);
			}
			const [, type, at] = rendered.params;
			const ofType = latestWritten(
				ledger.rows.filter((row) => row.type === type),
			);
			return at === undefined
				? ofType.slice(0, 1)
				: ofType.filter((row) => row.createdAt.getTime() === asTime(at));
		}
		if (keys === "createdAt,metadata") {
			return rendered.sql.includes(
				"`developer_credit_transactions`.`referenceId` <= ?",
			)
				? latestStorageDayRows().slice(0, 1)
				: latestWritten(storageRows()).slice(0, 1);
		}
		if (keys === "accountId,createdAt,id,metadata") {
			return latestStorageDayRows();
		}
		if (keys === "owedMicroCredits") {
			const shortSince = rendered.params.at(-1);
			const owed = ledger.rows
				.filter(
					(row) =>
						row.type === "video_create" &&
						row.metadata?.shortSince === shortSince &&
						row.metadata?.resolvedAt === undefined,
				)
				.map((row) => {
					const owedMicroCredits = Number(row.metadata?.owedMicroCredits) || 0;
					const charged = Number(row.metadata?.chargedMicroCredits) || 0;
					return Math.max(
						charged < owedMicroCredits ? owedMicroCredits : 0,
						Number(row.metadata?.outstandingMicroCredits) || 0,
					);
				});
			return [{ owedMicroCredits: owed.length ? Math.max(...owed) : null }];
		}
		if (keys === "metadata") {
			const since = asTime(rendered.params.at(-1));
			return storageRows().filter((row) => row.createdAt.getTime() >= since);
		}
		if (keys === "accountId,amountMicroCredits") {
			const [accountId, referenceId, ...referenceTypes] = rendered.params;
			return ledger.rows.filter(
				(row) =>
					row.type === "topup" &&
					row.accountId === accountId &&
					row.referenceId === referenceId &&
					referenceTypes.includes(row.referenceType),
			);
		}
		if (keys === "metadata,referenceId,referenceType") {
			const allowed = rendered.params.slice(1);
			return ledger.rows.filter(
				(row) =>
					allowed.includes(row.type) && allowed.includes(row.referenceType),
			);
		}
		if (keys === "value") {
			const column = (query.fields.value as { name?: string }).name ?? "";
			return latestWritten(
				ledger.rows.filter(
					(row) =>
						row.type === "adjustment" &&
						["stripe_dispute", "manual"].includes(String(row.referenceType)),
				),
			)
				.slice(0, 1)
				.map((row) => ({ value: row[column as keyof typeof row] ?? null }));
		}
		if (keys === "createdAt,referenceType") {
			const types = rendered.params.slice(2);
			return latestWritten(
				ledger.rows.filter(
					(row) =>
						row.type === "adjustment" && types.includes(row.referenceType),
				),
			).slice(0, 1);
		}
		if (keys === "pendingId,pendingRow,pendingSince") {
			return ledger.rows
				.filter(
					(row) =>
						row.type === "topup_pending" &&
						row.referenceType === "auto_top_up_pending",
				)
				.map((row) => ({
					pendingRow: row.id,
					pendingId: row.referenceId,
					pendingSince: row.createdAt,
				}));
		}
		if (keys === "reservation,reservedAt") {
			const [accountId, referenceId] = rendered.params;
			return ledger.rows
				.filter(
					(row) =>
						row.accountId === accountId &&
						row.referenceId === referenceId &&
						row.referenceType === "auto_top_up_pending",
				)
				.map((row) => ({
					reservation: row.metadata,
					reservedAt: row.createdAt,
				}));
		}
		if (keys === "settledId") {
			const ids = rendered.params.slice(3);
			return ledger.rows
				.filter(
					(row) =>
						(row.referenceType === "auto_top_up" ||
							row.referenceType === "auto_top_up_failed") &&
						ids.includes(row.referenceId),
				)
				.map((row) => ({ settledId: row.referenceId }));
		}
		if (keys === "declines,topUps") {
			const count = (type: string) =>
				ledger.rows.filter((row) => row.referenceType === type).length;
			return [
				{
					topUps: count("auto_top_up"),
					declines: count("auto_top_up_failed"),
				},
			];
		}
		if (keys === "createdAt,metadata,type") {
			const types = rendered.params.slice(1);
			return newestFirst(
				ledger.rows.filter((row) => types.includes(row.referenceType)),
			).slice(0, 1);
		}
		if (keys === "id" && rendered.sql.includes("JSON_EXTRACT")) {
			const [, since, , , owed] = rendered.params;
			return ledger.rows.filter(
				(row) =>
					row.createdAt.getTime() > asTime(since) &&
					row.amountMicroCredits > 0 &&
					availableAfter(row) >= Number(owed),
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

	if (query.table === developerApps && keys === "appDeletedAt") {
		const deletedAt = ledger.appDeletedBeforeLock
			? ledger.now
			: ledger.account.appDeletedAt;
		return [{ appDeletedAt: deletedAt }];
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
		const videos = rendered.sql.includes("<> ?")
			? ledger.videos.filter(
					(video) => !video.videoId || !rendered.params.includes(video.videoId),
				)
			: ledger.videos;
		const firstMonth = (seconds: number, perMinute: number) =>
			Math.max(1, Math.floor((seconds / 60) * perMinute));
		return videos.map((video) => ({
			...video,
			status: video.status ?? "ready",
			dailySeconds: video.dailySeconds ?? video.seconds,
			dailyCount: video.dailyCount ?? video.count,
			firstMonth1080p: firstMonth(video.seconds, 85),
			firstMonth1440p: firstMonth(video.seconds, 145),
			firstMonth2160p: firstMonth(video.seconds, 280),
		}));
	}

	if (keys === "storagePaidUntil" || keys === "createdAt") return [];

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
		leftJoin: () => chain,
		where(condition: SQL | undefined) {
			query.where = condition;
			const rows = Promise.resolve().then(() => runSelect(query));
			const result = Object.assign(rows, {
				orderBy: () => result,
				groupBy: () =>
					Object.assign(result, {
						as: (alias: string) => ({
							appId: sql.raw(`\`${alias}\`.\`appId\``),
							heldMicroCredits: sql.raw("`heldMicroCredits`"),
						}),
					}),
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
				async where(condition?: SQL) {
					if (table === developerCreditTransactions && values.metadata) {
						const params = condition
							? dialect.sqlToQuery(condition).params
							: [];
						const resolvedAt = dialect
							.sqlToQuery(values.metadata as SQL)
							.params.find((param) => typeof param === "string");
						const [first, ...rest] = params;
						const types = rest.slice(0, -1);
						const shortSince = rest.at(-1);
						const rows = ledger.rows.filter((entry) =>
							types.includes("video_create")
								? entry.accountId === first &&
									types.includes(entry.type) &&
									entry.metadata?.shortSince === shortSince
								: entry.id === first,
						);
						let affectedRows = 0;
						for (const row of rows) {
							if (row.metadata?.resolvedAt !== undefined) continue;
							row.metadata = { ...row.metadata, resolvedAt };
							affectedRows++;
						}
						return [{ affectedRows }];
					}
					if (table === developerCreditTransactions && condition) {
						const [accountId, referenceId, referenceType, rowId] =
							dialect.sqlToQuery(condition).params;
						const rows = ledger.rows.filter(
							(row) =>
								row.accountId === accountId &&
								row.referenceId === referenceId &&
								row.referenceType === referenceType &&
								(rowId === undefined || row.id === rowId),
						);
						for (const row of rows) Object.assign(row, values);
						return [{ affectedRows: rows.length }];
					}
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

function remove(table: unknown) {
	return {
		async where(condition: SQL) {
			if (table !== developerCreditTransactions) return [{ affectedRows: 0 }];
			const [accountId, referenceId, referenceType, rowId] =
				dialect.sqlToQuery(condition).params;
			const before = ledger.rows.length;
			ledger.rows = ledger.rows.filter(
				(row) =>
					!(
						row.accountId === accountId &&
						row.referenceId === referenceId &&
						row.referenceType === referenceType &&
						(rowId === undefined || row.id === rowId)
					),
			);
			return [{ affectedRows: before - ledger.rows.length }];
		},
	};
}

type FakeDb = {
	select: typeof select;
	update: typeof update;
	insert: typeof insert;
	delete: typeof remove;
	transaction: <T>(run: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

export const fakeDb: FakeDb = {
	select,
	update,
	insert,
	delete: remove,
	transaction: (run) => run(fakeDb),
};
