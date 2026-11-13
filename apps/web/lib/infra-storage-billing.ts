import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
} from "@cap/database/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import type { StorageUsage } from "@/lib/developer-pricing";
import { availableBalance } from "@/lib/infra-balance";
import {
	type InfraDbExecutor,
	latchCoveredShortfall,
	latestStorageCharge,
	restoredSinceCharge,
	STORAGE_DAY_REFERENCE_TYPE,
	storageChargeDay,
} from "@/lib/infra-standing";

export type StorageDayResult =
	| { state: "skipped" }
	| { state: "unpaid"; shortSince: Date }
	| {
			state: "billed";
			owedMicroCredits: number;
			chargedMicroCredits: number;
			balanceMicroCredits: number;
			shortSince: Date | null;
			fellShort: boolean;
	  };

export function settleStorageDay({
	balanceMicroCredits,
	availableMicroCredits = balanceMicroCredits,
	owedMicroCredits,
	unresolvedShortSince,
	now,
}: {
	balanceMicroCredits: number;
	availableMicroCredits?: number;
	owedMicroCredits: number;
	unresolvedShortSince: Date | null;
	now: Date;
}) {
	const owed = Math.max(0, Math.floor(owedMicroCredits));
	const spendable = Math.min(balanceMicroCredits, availableMicroCredits);
	const charged = Math.min(Math.max(0, spendable), owed);
	const short = charged < owed;
	return {
		owedMicroCredits: owed,
		chargedMicroCredits: charged,
		balanceMicroCredits: balanceMicroCredits - charged,
		shortSince: short ? (unresolvedShortSince ?? now) : null,
		fellShort: short && !unresolvedShortSince,
	};
}

export async function recordStorageDayVisits({
	appIds,
	dateKey,
	now,
}: {
	appIds: readonly string[];
	dateKey: string;
	now: Date;
}) {
	if (appIds.length === 0) return;
	await db()
		.insert(developerDailyStorageSnapshots)
		.values(
			appIds.map((appId) => ({
				id: nanoId(),
				appId,
				snapshotDate: dateKey,
				totalDurationMinutes: 0,
				videoCount: 0,
				microCreditsCharged: 0,
				processedAt: now,
			})),
		)
		.onDuplicateKeyUpdate({
			set: { appId: sql`${developerDailyStorageSnapshots.appId}` },
		});
}

export async function chargeStorageDay({
	appId,
	accountId,
	usage: measuredBefore,
	measure,
	dateKey,
	now,
	retryUnpaid = true,
}: {
	appId: string;
	accountId: string;
	usage: StorageUsage;
	measure?: (tx: InfraDbExecutor) => Promise<StorageUsage>;
	dateKey: string;
	now: Date;
	retryUnpaid?: boolean;
}): Promise<StorageDayResult> {
	return db().transaction(async (tx) => {
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
						STORAGE_DAY_REFERENCE_TYPE,
					),
				),
			)
			.limit(1);
		if (billed) return { state: "skipped" as const };

		const [snapshot] = await tx
			.select({
				processedAt: developerDailyStorageSnapshots.processedAt,
				microCreditsCharged: developerDailyStorageSnapshots.microCreditsCharged,
			})
			.from(developerDailyStorageSnapshots)
			.where(
				and(
					eq(developerDailyStorageSnapshots.appId, appId),
					eq(developerDailyStorageSnapshots.snapshotDate, dateKey),
				),
			)
			.limit(1);
		if (
			snapshot?.processedAt &&
			(Number(snapshot.microCreditsCharged) > 0 || !retryUnpaid)
		) {
			return { state: "skipped" as const };
		}

		const chargedSinceDayStart = await tx
			.select({ metadata: developerCreditTransactions.metadata })
			.from(developerCreditTransactions)
			.where(
				and(
					eq(developerCreditTransactions.accountId, accountId),
					eq(developerCreditTransactions.type, "storage_daily"),
					gte(
						developerCreditTransactions.createdAt,
						new Date(`${dateKey}T00:00:00.000Z`),
					),
				),
			);
		if (
			chargedSinceDayStart.some(
				(row) => storageChargeDay(row.metadata) === dateKey,
			)
		) {
			return { state: "skipped" as const };
		}

		const usage = measure ? await measure(tx) : measuredBefore;
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

		if (
			usage.dailyMicroCredits <= 0 &&
			(!unresolvedShortSince || lastCharge?.firstMonth)
		) {
			return { state: "skipped" as const };
		}

		const recordSnapshot = (chargedMicroCredits: number) =>
			usage.totalMinutes > 0
				? tx
						.insert(developerDailyStorageSnapshots)
						.values({
							id: nanoId(),
							appId,
							snapshotDate: dateKey,
							totalDurationMinutes: usage.totalMinutes,
							videoCount: usage.videoCount,
							microCreditsCharged: chargedMicroCredits,
							processedAt: now,
						})
						.onDuplicateKeyUpdate({
							set: {
								totalDurationMinutes: usage.totalMinutes,
								videoCount: usage.videoCount,
								microCreditsCharged: chargedMicroCredits,
								processedAt: now,
							},
						})
				: Promise.resolve();

		if (unresolvedShortSince && usage.dailyMicroCredits > 0 && available <= 0) {
			await recordSnapshot(0);
			return { state: "unpaid" as const, shortSince: unresolvedShortSince };
		}

		const settled = settleStorageDay({
			balanceMicroCredits: account.balanceMicroCredits,
			availableMicroCredits: available,
			owedMicroCredits: usage.dailyMicroCredits,
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

		await tx.insert(developerCreditTransactions).values({
			id: nanoId(),
			accountId,
			type: "storage_daily",
			amountMicroCredits:
				settled.chargedMicroCredits > 0 ? -settled.chargedMicroCredits : 0,
			balanceAfterMicroCredits: settled.balanceMicroCredits,
			referenceId: dateKey,
			referenceType: STORAGE_DAY_REFERENCE_TYPE,
			metadata: {
				snapshotDate: dateKey,
				owedMicroCredits: settled.owedMicroCredits,
				chargedMicroCredits: settled.chargedMicroCredits,
				shortSince: settled.shortSince?.toISOString() ?? null,
				fellShort: settled.fellShort,
				totalDurationMinutes: usage.totalMinutes,
				minutesByTier: usage.minutesByTier,
				videoCount: usage.videoCount,
			},
		});

		await recordSnapshot(settled.chargedMicroCredits);

		return { state: "billed" as const, ...settled };
	});
}
