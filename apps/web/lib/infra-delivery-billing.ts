import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { availableBalance } from "@/lib/infra-balance";
import { deliveryBillingStart } from "@/lib/infra-delivery-flag";
import {
	DELIVERY_MICRO_CREDITS_PER_1000_MINUTES,
	type DeliveredDay,
	deliveryMicroCredits,
	readDeliveredDays,
} from "@/lib/infra-delivery-rollup";
import {
	DELIVERY_DAY_REFERENCE_TYPE,
	DELIVERY_DAY_TRANSACTION_TYPE,
	type InfraDbExecutor,
	latchCoveredShortfall,
	latestStorageCharge,
	restoredSinceCharge,
} from "@/lib/infra-standing";
import { settleStorageDay } from "@/lib/infra-storage-billing";
import { utcDateKey } from "@/lib/infra-usage";

export { deliveryBillingStart };

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 10;

// The metering cron marks day D final once all of its logs are in, normally
// in its first run after 02:00 UTC on D+2, and never changes a final row. D is
// settled once, when every rollup row for the app and D is final, in any run
// from D+2 to D+7, so a day that goes final late, or a missed cron run, is
// still charged. Every settled day writes exactly one ledger row, even when
// the balance pays nothing, so a day is never charged later.
export const DELIVERY_FIRST_SETTLE_DAYS = 2;
export const DELIVERY_LAST_SETTLE_DAYS = 7;

export type DeliveryLedgerRow = {
	accountId: string;
	referenceId: string;
	amountMicroCredits: number;
	balanceAfterMicroCredits: number;
	metadata: {
		deliveryDate: string;
		owedMicroCredits: number;
		chargedMicroCredits: number;
		shortSince: string | null;
		fellShort: boolean;
		unpaid?: true;
		deliveredSeconds: number;
		minutesByTier: Record<string, number>;
		microCreditsPer1000Minutes: number;
	};
};

export type DeliveryDayResult =
	| { state: "skipped" }
	| {
			state: "billed";
			owedMicroCredits: number;
			chargedMicroCredits: number;
			balanceMicroCredits: number;
			shortSince: Date | null;
			fellShort: boolean;
			row: DeliveryLedgerRow;
	  };

export function deliverySettleDays(now: Date, startDay: string) {
	const days: string[] = [];
	for (
		let back = DELIVERY_LAST_SETTLE_DAYS;
		back >= DELIVERY_FIRST_SETTLE_DAYS;
		back--
	) {
		const day = utcDateKey(new Date(now.getTime() - back * DAY_MS));
		if (day >= startDay) days.push(day);
	}
	return days;
}

export function deliveryDayIsFinal(
	delivered: Pick<DeliveredDay, "day" | "final">,
	now: Date,
) {
	const dayStart = Date.parse(`${delivered.day}T00:00:00.000Z`);
	return (
		delivered.final &&
		now.getTime() >= dayStart + DELIVERY_FIRST_SETTLE_DAYS * DAY_MS
	);
}

const minutesByTier = (secondsByTier: Record<string, number>) =>
	Object.fromEntries(
		Object.entries(secondsByTier)
			.filter(([, seconds]) => seconds > 0)
			.map(([tier, seconds]) => [tier, Math.round((seconds / 60) * 100) / 100]),
	);

export async function chargeDeliveryDay({
	appId,
	accountId,
	delivered,
	now,
	executor = db(),
}: {
	appId: string;
	accountId: string;
	delivered: Pick<DeliveredDay, "day" | "seconds" | "secondsByTier">;
	now: Date;
	executor?: InfraDbExecutor;
}): Promise<DeliveryDayResult> {
	const owedMicroCredits = deliveryMicroCredits(delivered.seconds);
	if (owedMicroCredits <= 0) return { state: "skipped" };
	const dateKey = delivered.day;

	return executor.transaction(async (tx) => {
		const [account] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, accountId))
			.limit(1)
			.for("update");
		if (!account) return { state: "skipped" as const };

		const [billed] = await tx
			.select({ id: developerCreditTransactions.id })
			.from(developerCreditTransactions)
			.where(
				and(
					eq(developerCreditTransactions.accountId, accountId),
					eq(developerCreditTransactions.referenceId, dateKey),
					eq(
						developerCreditTransactions.referenceType,
						DELIVERY_DAY_REFERENCE_TYPE,
					),
				),
			)
			.limit(1);
		if (billed) return { state: "skipped" as const };

		const lastCharge = await latestStorageCharge(tx, accountId);
		const available = (await availableBalance(appId, tx)) ?? 0;
		const latched = await latchCoveredShortfall(
			tx,
			lastCharge,
			available,
			now,
			accountId,
		);
		const unresolvedShortSince =
			!latched &&
			lastCharge?.shortSince &&
			!(await restoredSinceCharge(tx, accountId, lastCharge))
				? lastCharge.shortSince
				: null;

		const settled = settleStorageDay({
			balanceMicroCredits: account.balanceMicroCredits,
			availableMicroCredits: available,
			owedMicroCredits,
			unresolvedShortSince,
			now,
		});

		if (settled.chargedMicroCredits > 0) {
			await tx
				.update(developerCreditAccounts)
				.set({
					balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${settled.chargedMicroCredits}`,
				})
				.where(eq(developerCreditAccounts.id, accountId));
		}

		const row: DeliveryLedgerRow = {
			accountId,
			amountMicroCredits:
				settled.chargedMicroCredits > 0 ? -settled.chargedMicroCredits : 0,
			balanceAfterMicroCredits: settled.balanceMicroCredits,
			referenceId: dateKey,
			metadata: {
				deliveryDate: dateKey,
				owedMicroCredits: settled.owedMicroCredits,
				chargedMicroCredits: settled.chargedMicroCredits,
				shortSince: settled.shortSince?.toISOString() ?? null,
				fellShort: settled.fellShort,
				...(unresolvedShortSince && settled.chargedMicroCredits === 0
					? { unpaid: true as const }
					: {}),
				deliveredSeconds: delivered.seconds,
				minutesByTier: minutesByTier(delivered.secondsByTier),
				microCreditsPer1000Minutes: DELIVERY_MICRO_CREDITS_PER_1000_MINUTES,
			},
		};
		await tx.insert(developerCreditTransactions).values({
			...row,
			id: nanoId(),
			type: DELIVERY_DAY_TRANSACTION_TYPE,
			referenceType: DELIVERY_DAY_REFERENCE_TYPE,
		});

		return { state: "billed" as const, ...settled, row };
	});
}

export async function markDeliveryDayNotified(
	accountId: string,
	dateKey: string,
	now: Date,
) {
	await db()
		.update(developerCreditTransactions)
		.set({
			metadata: sql`JSON_SET(COALESCE(${developerCreditTransactions.metadata}, JSON_OBJECT()), '$.notifiedAt', ${now.toISOString()})`,
		})
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.referenceId, dateKey),
				eq(
					developerCreditTransactions.referenceType,
					DELIVERY_DAY_REFERENCE_TYPE,
				),
				sql`JSON_EXTRACT(${developerCreditTransactions.metadata}, '$.notifiedAt') IS NULL`,
			),
		);
}

async function scheduleTopUpAfterCharge(accountId: string) {
	try {
		const { scheduleAutoTopUp } = await import("@/lib/infra-auto-top-up");
		await scheduleAutoTopUp({ accountId });
	} catch (error) {
		console.error("[infra-delivery] Auto top-up after a delivery day failed", {
			accountId,
			error,
		});
	}
}

export type DeliveryPlannedRow = DeliveryLedgerRow & { appId: string };

class DryRunRollback extends Error {}

export type DeliverySweep = {
	dryRun: boolean;
	planned: DeliveryPlannedRow[];
	enabled: boolean;
	tableReady: boolean;
	complete: boolean;
	billed: number;
	short: number;
	notFinalAtWindowEnd: number;
	failed: number;
	waiting: number;
	ms: number;
};

export async function settleDeliveryDays({
	now,
	startDay,
	outOfTime = () => false,
	onFellShort,
	dryRun = false,
}: {
	now: Date;
	startDay: string | null;
	outOfTime?: () => boolean;
	dryRun?: boolean;
	onFellShort?: (shortfall: {
		accountId: string;
		dateKey: string;
		shortSince: Date;
	}) => Promise<void>;
}): Promise<DeliverySweep> {
	const startedAt = Date.now();
	const sweep: DeliverySweep = {
		dryRun,
		planned: [],
		enabled: !!startDay,
		tableReady: false,
		complete: true,
		billed: 0,
		short: 0,
		notFinalAtWindowEnd: 0,
		failed: 0,
		waiting: 0,
		ms: 0,
	};
	const finish = () => ({
		...sweep,
		planned: [...sweep.planned].sort(
			(a, b) =>
				a.appId.localeCompare(b.appId) ||
				a.referenceId.localeCompare(b.referenceId),
		),
		ms: Date.now() - startedAt,
	});
	if (!startDay) return finish();
	const days = deliverySettleDays(now, startDay);
	const [from] = days;
	const to = days.at(-1);
	if (!from || !to) return finish();

	const delivered = await readDeliveredDays({ from, to });
	if (!delivered) return finish();
	sweep.tableReady = true;

	const windowEnd = utcDateKey(
		new Date(now.getTime() - DELIVERY_LAST_SETTLE_DAYS * DAY_MS),
	);
	const due = delivered.filter((day) => {
		if (!days.includes(day.day)) return false;
		if (!deliveryDayIsFinal(day, now)) {
			sweep.waiting++;
			if (day.day === windowEnd) sweep.notFinalAtWindowEnd++;
			return false;
		}
		return deliveryMicroCredits(day.seconds) > 0;
	});
	if (sweep.notFinalAtWindowEnd > 0) {
		console.warn(
			"[infra-delivery] Delivery days still not final on the last day they can be charged",
			{ day: windowEnd, apps: sweep.notFinalAtWindowEnd },
		);
	}
	if (due.length === 0) return finish();

	const appIds = [...new Set(due.map((day) => day.appId))];
	const accounts = await db()
		.select({ id: developerCreditAccounts.id, appId: developerApps.id })
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerApps.id, developerCreditAccounts.appId),
		)
		.where(
			and(
				inArray(developerCreditAccounts.appId, appIds),
				isNull(developerApps.deletedAt),
			),
		);
	const accountOf = new Map(accounts.map((row) => [row.appId, row.id]));
	const billed =
		accounts.length > 0
			? await db()
					.select({
						accountId: developerCreditTransactions.accountId,
						day: developerCreditTransactions.referenceId,
					})
					.from(developerCreditTransactions)
					.where(
						and(
							inArray(
								developerCreditTransactions.accountId,
								accounts.map((row) => row.id),
							),
							eq(
								developerCreditTransactions.referenceType,
								DELIVERY_DAY_REFERENCE_TYPE,
							),
							inArray(developerCreditTransactions.referenceId, days),
						),
					)
			: [];
	const billedKeys = new Set(
		billed.map((row) => `${row.accountId}:${row.day}`),
	);

	const byAccount = new Map<string, { appId: string; days: DeliveredDay[] }>();
	for (const day of due) {
		const accountId = accountOf.get(day.appId);
		if (!accountId || billedKeys.has(`${accountId}:${day.day}`)) continue;
		const entry = byAccount.get(accountId) ?? { appId: day.appId, days: [] };
		entry.days.push(day);
		byAccount.set(accountId, entry);
	}
	const accountApp = new Map(accounts.map((row) => [row.id, row.appId]));
	const pending = [...byAccount.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([accountId, entry]) => ({
			accountId,
			appId: entry.appId,
			days: entry.days.sort((a, b) => (a.day < b.day ? -1 : 1)),
		}));

	for (let i = 0; i < pending.length; i += BATCH_SIZE) {
		if (outOfTime()) {
			sweep.complete = false;
			break;
		}
		const results = await Promise.allSettled(
			pending
				.slice(i, i + BATCH_SIZE)
				.map(async ({ accountId, appId, days }) => {
					if (dryRun) return planAccountDays(appId, accountId, days, now);
					const outcomes: DeliveryDayResult[] = [];
					let charged = false;
					for (const day of days) {
						const result = await chargeDeliveryDay({
							appId,
							accountId,
							delivered: day,
							now,
						});
						outcomes.push(result);
						if (result.state === "billed") {
							if (result.chargedMicroCredits > 0) charged = true;
							if (result.fellShort && result.shortSince && onFellShort) {
								await onFellShort({
									accountId,
									dateKey: day.day,
									shortSince: result.shortSince,
								});
							}
						}
					}
					if (charged) await scheduleTopUpAfterCharge(accountId);
					return outcomes;
				}),
		);
		for (const result of results) {
			if (result.status === "rejected") {
				sweep.failed++;
				console.error("[infra-delivery] Delivery day failed", result.reason);
				continue;
			}
			for (const outcome of result.value) {
				if (outcome.state === "billed") {
					if (dryRun)
						sweep.planned.push({
							...outcome.row,
							appId: accountApp.get(outcome.row.accountId) ?? "",
						});
					sweep.billed++;
					if (outcome.shortSince) sweep.short++;
				}
			}
		}
	}
	return finish();
}

// A dry run takes the same path as a real debit, in a transaction that is
// always rolled back, so it returns exactly the rows a real run would write
// (with each day seeing the days before it) and commits nothing.
async function planAccountDays(
	appId: string,
	accountId: string,
	days: readonly DeliveredDay[],
	now: Date,
) {
	const outcomes: DeliveryDayResult[] = [];
	try {
		await db().transaction(async (tx) => {
			for (const day of days) {
				outcomes.push(
					await chargeDeliveryDay({
						appId,
						accountId,
						delivered: day,
						now,
						executor: tx,
					}),
				);
			}
			throw new DryRunRollback();
		});
	} catch (error) {
		if (!(error instanceof DryRunRollback)) throw error;
	}
	return outcomes;
}
