import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerVideos,
} from "@cap/database/schema";
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	sql,
} from "drizzle-orm";
import {
	firstMonthStorageMicroCredits,
	firstMonthStoragePaidUntil,
	STORAGE_BILLING_DAYS_PER_MONTH,
	videoStorageTier,
} from "@/lib/developer-pricing";
import { availableBalance } from "@/lib/infra-balance";
import {
	INFRA_RESOLUTION_TIERS,
	type InfraResolutionTier,
} from "@/lib/infra-pricing";
import {
	FIRST_MONTH_REFERENCE_TYPE,
	FIRST_MONTH_TRANSACTION_TYPE,
	type InfraDbExecutor,
	latchCoveredShortfall,
	latestStorageCharge,
	parseStorageCharge,
	restoredSinceCharge,
	STORAGE_DAY_REFERENCE_TYPE,
} from "@/lib/infra-standing";
import { settleStorageDay } from "@/lib/infra-storage-billing";
import { utcDateKey } from "@/lib/infra-usage";

export type FirstMonthCharge =
	| {
			state: "charged";
			accountId: string;
			tier: InfraResolutionTier;
			owedMicroCredits: number;
			chargedMicroCredits: number;
			balanceMicroCredits: number;
			paidUntil: Date;
			shortSince: Date | null;
			fellShort: boolean;
	  }
	| { state: "exempt"; paidUntil: Date }
	| {
			state: "skipped";
			reason: "missing" | "already_settled" | "not_ready";
	  };

export type FirstMonthOptions = {
	executor?: InfraDbExecutor;
	deletedBeforeReady?: boolean;
	exemptIfDeleted?: boolean;
	now?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const skipped = (
	reason: Extract<FirstMonthCharge, { state: "skipped" }>["reason"],
): FirstMonthCharge => ({ state: "skipped", reason });

const isTier = (value: unknown): value is InfraResolutionTier =>
	INFRA_RESOLUTION_TIERS.some((tier) => tier === value);

const positive = (value: number | null) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

async function dayAlreadyBilled(
	tx: InfraDbExecutor,
	accountId: string | null,
	now: Date,
) {
	if (!accountId) return false;
	const [billed] = await tx
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.referenceId, utcDateKey(now)),
				eq(
					developerCreditTransactions.referenceType,
					STORAGE_DAY_REFERENCE_TYPE,
				),
			),
		)
		.limit(1);
	return !!billed;
}

async function settleFirstMonth(
	tx: InfraDbExecutor,
	videoId: string,
	appId: string,
	options: FirstMonthOptions,
): Promise<FirstMonthCharge> {
	const now = options.now ?? new Date();
	const [account] = await tx
		.select({
			id: developerCreditAccounts.id,
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.for("update");

	const [video] = await tx
		.select({
			status: developerVideos.status,
			duration: developerVideos.duration,
			width: developerVideos.width,
			height: developerVideos.height,
			maxResolutionTier: developerVideos.maxResolutionTier,
			processing: developerVideos.processing,
			storagePaidUntil: developerVideos.storagePaidUntil,
			deletedAt: developerVideos.deletedAt,
		})
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId))
		.for("update");
	if (!video) return skipped("missing");
	if (video.storagePaidUntil !== null) return skipped("already_settled");
	if (video.status !== "ready") return skipped("not_ready");

	const paidUntil = firstMonthStoragePaidUntil(
		now,
		await dayAlreadyBilled(tx, account?.id ?? null, now),
	);
	const markSettled = () =>
		tx
			.update(developerVideos)
			.set({
				storagePaidUntil: paidUntil,
				updatedAt: sql`${developerVideos.updatedAt}`,
			})
			.where(eq(developerVideos.id, videoId));

	if (
		options.deletedBeforeReady ||
		(options.exemptIfDeleted && video.deletedAt !== null) ||
		video.processing === null ||
		!account
	) {
		await markSettled();
		return { state: "exempt", paidUntil };
	}

	const [recorded] = await tx
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, account.id),
				eq(developerCreditTransactions.referenceId, videoId),
				eq(
					developerCreditTransactions.referenceType,
					FIRST_MONTH_REFERENCE_TYPE,
				),
				eq(developerCreditTransactions.type, FIRST_MONTH_TRANSACTION_TYPE),
			),
		)
		.limit(1);
	if (recorded) {
		await markSettled();
		return skipped("already_settled");
	}

	const durationSeconds = positive(video.duration);
	const tier = videoStorageTier(
		{ width: positive(video.width), height: positive(video.height) },
		isTier(video.maxResolutionTier) ? video.maxResolutionTier : null,
	);
	const lastCharge = await latestStorageCharge(tx, account.id);
	const available =
		(await availableBalance(appId, tx)) ?? account.balanceMicroCredits;
	const latched = await latchCoveredShortfall(tx, lastCharge, available, now);
	const unresolvedShortSince =
		!latched &&
		lastCharge?.shortSince &&
		!(await restoredSinceCharge(tx, account.id, lastCharge))
			? lastCharge.shortSince
			: null;
	const settled = settleStorageDay({
		balanceMicroCredits: account.balanceMicroCredits,
		availableMicroCredits: available,
		owedMicroCredits: firstMonthStorageMicroCredits({ durationSeconds, tier }),
		unresolvedShortSince,
		now,
	});

	if (settled.chargedMicroCredits > 0) {
		await tx
			.update(developerCreditAccounts)
			.set({
				balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${settled.chargedMicroCredits}`,
			})
			.where(eq(developerCreditAccounts.id, account.id));
	}
	await tx.insert(developerCreditTransactions).values({
		id: nanoId(),
		accountId: account.id,
		type: FIRST_MONTH_TRANSACTION_TYPE,
		amountMicroCredits:
			settled.chargedMicroCredits > 0 ? -settled.chargedMicroCredits : 0,
		balanceAfterMicroCredits: settled.balanceMicroCredits,
		referenceId: videoId,
		referenceType: FIRST_MONTH_REFERENCE_TYPE,
		metadata: {
			owedMicroCredits: settled.owedMicroCredits,
			chargedMicroCredits: settled.chargedMicroCredits,
			shortSince: settled.shortSince?.toISOString() ?? null,
			durationSeconds,
			tier,
			paidUntil: paidUntil.toISOString(),
		},
	});
	await markSettled();

	return {
		state: "charged",
		accountId: account.id,
		tier,
		paidUntil,
		...settled,
	};
}

export async function chargeDeveloperVideoFirstMonth(
	videoId: string,
	options: FirstMonthOptions = {},
): Promise<FirstMonthCharge> {
	const executor = options.executor ?? db();
	const [found] = await executor
		.select({ appId: developerVideos.appId })
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId))
		.limit(1);
	if (!found) return skipped("missing");
	return executor.transaction((tx) =>
		settleFirstMonth(tx, videoId, found.appId, options),
	);
}

export async function settleFirstMonthAtReady(
	video: { id: string; deletedAt: Date | null },
	executor?: InfraDbExecutor,
): Promise<void> {
	try {
		await chargeDeveloperVideoFirstMonth(video.id, {
			executor,
			deletedBeforeReady: video.deletedAt !== null,
		});
	} catch (error) {
		console.error("[infra-storage] First month charge failed at ready", {
			videoId: video.id,
			error,
		});
	}
}

const BACKSTOP_BATCH = 200;

export async function firstMonthChargesBegan(
	executor: Pick<InfraDbExecutor, "select"> = db(),
): Promise<Date | null> {
	const [earliest] = await executor
		.select({ storagePaidUntil: developerVideos.storagePaidUntil })
		.from(developerVideos)
		.where(isNotNull(developerVideos.storagePaidUntil))
		.orderBy(asc(developerVideos.storagePaidUntil))
		.limit(1);
	return earliest?.storagePaidUntil
		? new Date(
				earliest.storagePaidUntil.getTime() -
					(STORAGE_BILLING_DAYS_PER_MONTH - 1) * DAY_MS,
			)
		: null;
}

export function unsettledFirstMonthsQuery(
	createdSince: Date,
	limit: number,
	executor: Pick<InfraDbExecutor, "select"> = db(),
) {
	return executor
		.select({ id: developerVideos.id })
		.from(developerVideos)
		.where(
			and(
				isNull(developerVideos.storagePaidUntil),
				eq(developerVideos.status, "ready"),
				gte(developerVideos.createdAt, createdSince),
			),
		)
		.orderBy(asc(developerVideos.createdAt))
		.limit(limit);
}

export async function chargeMissedFirstMonths(
	now: Date = new Date(),
	limit: number = BACKSTOP_BATCH,
) {
	const outcome = { charged: 0, short: 0, failed: 0 };
	const began = await firstMonthChargesBegan();
	if (!began) return outcome;
	for (const video of await unsettledFirstMonthsQuery(began, limit)) {
		try {
			const result = await chargeDeveloperVideoFirstMonth(video.id, {
				now,
				exemptIfDeleted: true,
			});
			if (result.state === "charged") {
				outcome.charged++;
				if (result.shortSince) outcome.short++;
			}
		} catch (error) {
			outcome.failed++;
			console.error("[infra-storage] Missed first month charge failed", {
				videoId: video.id,
				error,
			});
		}
	}
	return outcome;
}

export async function firstMonthShortfallsSince(
	accountIds: readonly string[],
	since: Date,
	executor: Pick<InfraDbExecutor, "select"> = db(),
) {
	const shortfalls = new Map<string, Date>();
	if (accountIds.length === 0) return shortfalls;
	const rows = await executor
		.select({
			accountId: developerCreditTransactions.accountId,
			createdAt: developerCreditTransactions.createdAt,
			metadata: developerCreditTransactions.metadata,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				inArray(developerCreditTransactions.accountId, [...accountIds]),
				eq(developerCreditTransactions.type, FIRST_MONTH_TRANSACTION_TYPE),
				gte(developerCreditTransactions.createdAt, since),
			),
		);
	for (const row of rows) {
		const { shortSince } = parseStorageCharge(row);
		if (shortSince && shortSince.getTime() >= since.getTime()) {
			shortfalls.set(row.accountId, shortSince);
		}
	}
	return shortfalls;
}

export async function openFirstMonthShortfalls(
	accountIds: readonly string[],
	executor: InfraDbExecutor = db(),
) {
	if (accountIds.length === 0) return new Set<string>();
	const rows = await executor
		.selectDistinct({ accountId: developerCreditTransactions.accountId })
		.from(developerCreditTransactions)
		.where(
			and(
				inArray(developerCreditTransactions.accountId, [...accountIds]),
				eq(developerCreditTransactions.type, FIRST_MONTH_TRANSACTION_TYPE),
				sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${developerCreditTransactions.metadata}, '$.shortSince')), 'null') <> 'null'`,
				sql`JSON_EXTRACT(${developerCreditTransactions.metadata}, '$.resolvedAt') IS NULL`,
			),
		);
	return new Set(rows.map((row) => row.accountId));
}
