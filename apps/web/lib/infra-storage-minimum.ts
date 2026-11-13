import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerVideos,
} from "@cap/database/schema";
import type { DeveloperVideoProcessingState } from "@cap/database/types";
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
import { DEVELOPER_VIDEO_MAX_DURATION_SECONDS } from "@/lib/developer-video-charge";
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
			reason:
				| "missing"
				| "already_settled"
				| "not_ready"
				| "not_deleted"
				| "not_dispatched";
	  };

export type FirstMonthOptions = {
	executor?: InfraDbExecutor;
	deletedBeforeReady?: boolean;
	exemptIfDeleted?: boolean;
	atDelete?: boolean;
	now?: Date;
};

const encodeDispatched = (processing: DeveloperVideoProcessingState) =>
	[processing.mp4, processing.hls].some(
		(part) =>
			(part.state === "running" && part.jobId !== null) ||
			part.state === "complete",
	) || Object.values(processing.lostJobs ?? {}).some((lost) => (lost ?? 0) > 0);

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
			createdAt: developerVideos.createdAt,
		})
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId))
		.for("update");
	if (!video) return skipped("missing");
	if (video.storagePaidUntil !== null) return skipped("already_settled");
	let exemptAtDelete = false;
	if (options.atDelete) {
		if (video.deletedAt === null) return skipped("not_deleted");
		const encoding =
			video.status === "processing" &&
			video.processing !== null &&
			video.duration !== null &&
			encodeDispatched(video.processing);
		if (video.status !== "ready" && !encoding) return skipped("not_dispatched");
		const began = encoding ? await firstMonthChargesBegan(tx) : null;
		exemptAtDelete =
			!encoding ||
			!began ||
			new Date(video.createdAt).getTime() < began.getTime();
	} else if (video.status !== "ready") {
		return skipped("not_ready");
	}

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
		exemptAtDelete ||
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

	const durationSeconds = Math.min(
		positive(video.duration),
		DEVELOPER_VIDEO_MAX_DURATION_SECONDS,
	);
	const maxTier = isTier(video.maxResolutionTier)
		? video.maxResolutionTier
		: null;
	const measured = positive(video.width) > 0 && positive(video.height) > 0;
	const tier =
		!measured && maxTier
			? maxTier
			: videoStorageTier(
					{ width: positive(video.width), height: positive(video.height) },
					maxTier,
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
			fellShort: settled.fellShort,
			durationSeconds,
			tier,
			paidUntil: paidUntil.toISOString(),
			...(options.atDelete && video.status !== "ready"
				? { deletedWhileEncoding: true }
				: {}),
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

export async function settleFirstMonthAtDelete(
	videoId: string,
): Promise<FirstMonthCharge | null> {
	try {
		return await chargeDeveloperVideoFirstMonth(videoId, { atDelete: true });
	} catch (error) {
		console.error("[infra-storage] First month charge failed at delete", {
			videoId,
			error,
		});
		return null;
	}
}

export async function settleFirstMonthsForDeletedApp(
	appId: string,
	deletedAt: Date,
) {
	try {
		const videos = await db()
			.select({ id: developerVideos.id })
			.from(developerVideos)
			.where(
				and(
					eq(developerVideos.appId, appId),
					eq(developerVideos.deletedAt, deletedAt),
					eq(developerVideos.status, "processing"),
					isNull(developerVideos.storagePaidUntil),
				),
			);
		for (const video of videos) await settleFirstMonthAtDelete(video.id);
	} catch (error) {
		console.error("[infra-storage] First month charges failed at app delete", {
			appId,
			error,
		});
	}
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
	const shortfalls = new Map<string, { shortSince: Date; ids: string[] }>();
	if (accountIds.length === 0) return shortfalls;
	const rows = await executor
		.select({
			id: developerCreditTransactions.id,
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
		const fields =
			typeof row.metadata === "object" && row.metadata !== null
				? (row.metadata as Record<string, unknown>)
				: {};
		if (!shortSince || fields.fellShort !== true || fields.notifiedAt) continue;
		const shortfall = shortfalls.get(row.accountId) ?? {
			shortSince,
			ids: [],
		};
		shortfall.ids.push(row.id);
		shortfalls.set(row.accountId, shortfall);
	}
	return shortfalls;
}

export async function markFirstMonthShortfallsNotified(
	ids: readonly string[],
	now: Date,
	executor: InfraDbExecutor = db(),
) {
	if (ids.length === 0) return;
	await executor
		.update(developerCreditTransactions)
		.set({
			metadata: sql`JSON_SET(COALESCE(${developerCreditTransactions.metadata}, JSON_OBJECT()), '$.notifiedAt', ${now.toISOString()})`,
		})
		.where(
			and(
				inArray(developerCreditTransactions.id, [...ids]),
				sql`JSON_EXTRACT(${developerCreditTransactions.metadata}, '$.notifiedAt') IS NULL`,
			),
		);
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
