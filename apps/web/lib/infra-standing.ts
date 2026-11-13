import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { cache } from "react";
import {
	type BillableVideo,
	UPLOAD_ADMISSION_DAYS,
	uploadAdmissionMicroCredits,
} from "@/lib/developer-pricing";
import {
	AVAILABLE_AFTER_FIELD,
	heldTranscriptsQuery,
} from "@/lib/infra-balance";
import { deliveryBillingStart } from "@/lib/infra-delivery-flag";
import {
	FIRST_MONTH_REFERENCE_TYPE,
	FIRST_MONTH_TRANSACTION_TYPE,
} from "@/lib/infra-first-month-start";
import { type AppStorage, getAppStorage } from "@/lib/infra-storage";
import { formatCredits, formatNeed, utcDateKey } from "@/lib/infra-usage";

export const INFRA_GRACE_DAYS = 7;
export const STORAGE_DAY_REFERENCE_TYPE = "storage_day" as const;
export const DELIVERY_DAY_TRANSACTION_TYPE = "delivery_daily" as const;
export const DELIVERY_DAY_REFERENCE_TYPE = "delivery_day" as const;
export { FIRST_MONTH_REFERENCE_TYPE, FIRST_MONTH_TRANSACTION_TYPE };
export const STRIPE_DISPUTE_REFERENCE_TYPE = "stripe_dispute" as const;
export const DISPUTE_REVIEW_REFERENCE_TYPE = "manual" as const;
export const DISPUTED_UPLOAD_MESSAGE =
	"A payment for this app was disputed, so uploads are blocked and playback is paused. Contact us to restore it.";

const GRACE_MS = INFRA_GRACE_DAYS * 24 * 60 * 60 * 1000;

export type InfraStandingState = "active" | "grace" | "paused";

export type InfraAppStanding = {
	state: InfraStandingState;
	pausesAt: Date | null;
	disputed?: boolean;
};

export type StorageCharge = {
	id?: string;
	createdAt: Date;
	owedMicroCredits: number;
	shortSince: Date | null;
	resolvedAt?: Date | null;
	firstMonth?: boolean;
};

export type InfraUploadAdmission = {
	allowed: boolean;
	reason: "no_account" | "out_of_credit" | "insufficient_credits" | null;
	standing: InfraAppStanding;
	balanceMicroCredits: number;
	requiredMicroCredits: number;
	shortfallMicroCredits: number;
	message: string | null;
};

type Database = ReturnType<typeof db>;
export type InfraDbExecutor =
	| Database
	| Parameters<Parameters<Database["transaction"]>[0]>[0];

const ACTIVE: InfraAppStanding = { state: "active", pausesAt: null };

function metadataFields(value: unknown): Record<string, unknown> {
	let metadata: unknown = value;
	if (typeof metadata === "string") {
		try {
			metadata = JSON.parse(metadata);
		} catch {
			metadata = null;
		}
	}
	return typeof metadata === "object" && metadata !== null
		? (metadata as Record<string, unknown>)
		: {};
}

export function storageChargeDay(metadata: unknown): string | null {
	const { snapshotDate } = metadataFields(metadata);
	return typeof snapshotDate === "string" ? snapshotDate : null;
}

const dateField = (value: unknown) => {
	const date = typeof value === "string" ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date : null;
};

export function parseStorageCharge(row: {
	id?: string;
	createdAt: Date;
	metadata: unknown;
}): StorageCharge {
	const fields = metadataFields(row.metadata);
	const resolvedAt = dateField(fields.resolvedAt);
	return {
		...(row.id ? { id: row.id } : {}),
		createdAt: new Date(row.createdAt),
		owedMicroCredits: Math.max(
			0,
			Number(fields.owedMicroCredits) || 0,
			Number(fields.outstandingMicroCredits) || 0,
		),
		shortSince: dateField(fields.shortSince),
		...(resolvedAt ? { resolvedAt } : {}),
	};
}

export function resolveStanding({
	balanceMicroCredits,
	lastCharge,
	restored,
	now,
}: {
	balanceMicroCredits: number;
	lastCharge: StorageCharge | null;
	restored: boolean;
	now: Date;
}): InfraAppStanding {
	if (!lastCharge?.shortSince) return ACTIVE;
	if (restored || balanceMicroCredits >= lastCharge.owedMicroCredits) {
		return ACTIVE;
	}
	const pausesAt = new Date(lastCharge.shortSince.getTime() + GRACE_MS);
	return {
		state: now.getTime() < pausesAt.getTime() ? "grace" : "paused",
		pausesAt,
	};
}

const storageDayCeiling = () =>
	utcDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));

const storageDayRows = () =>
	and(
		eq(developerCreditTransactions.type, "storage_daily"),
		eq(developerCreditTransactions.referenceType, STORAGE_DAY_REFERENCE_TYPE),
	);

const latestStorageDay = (accountId: string, ceiling: string) =>
	sql`(select ${developerCreditTransactions.accountId}, ${developerCreditTransactions.referenceId} from ${developerCreditTransactions} where ${developerCreditTransactions.accountId} = ${accountId} and ${developerCreditTransactions.referenceType} = ${STORAGE_DAY_REFERENCE_TYPE} and ${developerCreditTransactions.referenceId} <= ${ceiling} order by ${developerCreditTransactions.referenceId} desc limit 1)`;

async function latestDeliveryCharge(
	executor: InfraDbExecutor,
	accountId: string,
) {
	const [row] = await executor
		.select({
			id: developerCreditTransactions.id,
			createdAt: developerCreditTransactions.createdAt,
			metadata: developerCreditTransactions.metadata,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.type, DELIVERY_DAY_TRANSACTION_TYPE),
				eq(
					developerCreditTransactions.referenceType,
					DELIVERY_DAY_REFERENCE_TYPE,
				),
			),
		)
		.orderBy(
			desc(developerCreditTransactions.createdAt),
			desc(developerCreditTransactions.referenceId),
			desc(developerCreditTransactions.id),
		)
		.limit(1);
	return row ?? null;
}

// A delivery day is charged once its CDN logs are final, at least two days
// after it ends, so it is ordered against storage days by when it was posted
// rather than by its day key. createdAt has whole-second precision and ids are
// random, so delivery days posted in the same second, which a sweep settles
// oldest first, are ordered by their day. The later posted daily charge carries the standing,
// exactly as the latest storage day does on its own. While delivery billing
// is off, no delivery row is read, so standing is exactly as before.
async function latestDailyCharge(executor: InfraDbExecutor, accountId: string) {
	const [storage, delivery] = await Promise.all([
		latestStorageDayCharge(executor, accountId),
		deliveryBillingStart() ? latestDeliveryCharge(executor, accountId) : null,
	]);
	const latest =
		delivery &&
		(!storage ||
			new Date(delivery.createdAt).getTime() >=
				new Date(storage.createdAt).getTime())
			? delivery
			: storage;
	return latest ? parseStorageCharge(latest) : null;
}

async function latestStorageDayCharge(
	executor: InfraDbExecutor,
	accountId: string,
) {
	const [row] = await executor
		.select({
			id: developerCreditTransactions.id,
			createdAt: developerCreditTransactions.createdAt,
			metadata: developerCreditTransactions.metadata,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				storageDayRows(),
				lte(developerCreditTransactions.referenceId, storageDayCeiling()),
			),
		)
		.orderBy(
			desc(developerCreditTransactions.referenceId),
			desc(developerCreditTransactions.id),
		)
		.limit(1);
	return row ?? null;
}

async function latestFirstMonthCharge(
	executor: InfraDbExecutor,
	accountId: string,
) {
	const ofAccount = and(
		eq(developerCreditTransactions.accountId, accountId),
		eq(developerCreditTransactions.type, FIRST_MONTH_TRANSACTION_TYPE),
	);
	const [latest] = await executor
		.select({ createdAt: developerCreditTransactions.createdAt })
		.from(developerCreditTransactions)
		.where(ofAccount)
		.orderBy(desc(developerCreditTransactions.createdAt))
		.limit(1);
	if (!latest) return null;
	const sameSecond = (
		await executor
			.select({
				id: developerCreditTransactions.id,
				createdAt: developerCreditTransactions.createdAt,
				metadata: developerCreditTransactions.metadata,
			})
			.from(developerCreditTransactions)
			.where(
				and(
					ofAccount,
					eq(developerCreditTransactions.createdAt, latest.createdAt),
				),
			)
	).map(parseStorageCharge);
	const largestFirst = [...sameSecond].sort(
		(a, b) => b.owedMicroCredits - a.owedMicroCredits,
	);
	return (
		largestFirst.find((charge) => charge.shortSince && !charge.resolvedAt) ??
		largestFirst.find((charge) => charge.shortSince) ??
		sameSecond[0] ??
		null
	);
}

const openShortfall = (shortSince: Date) =>
	and(
		sql`JSON_UNQUOTE(JSON_EXTRACT(${developerCreditTransactions.metadata}, '$.shortSince')) = ${shortSince.toISOString()}`,
		sql`JSON_EXTRACT(${developerCreditTransactions.metadata}, '$.resolvedAt') IS NULL`,
	);

const shortfallRows = (accountId: string, shortSince: Date) =>
	and(
		eq(developerCreditTransactions.accountId, accountId),
		inArray(developerCreditTransactions.type, [
			FIRST_MONTH_TRANSACTION_TYPE,
			"storage_daily",
			DELIVERY_DAY_TRANSACTION_TYPE,
		]),
		openShortfall(shortSince),
	);

export async function firstMonthShortfallOwed(
	executor: InfraDbExecutor,
	accountId: string,
	shortSince: Date,
) {
	const field = (name: string) =>
		sql`COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(${developerCreditTransactions.metadata}, ${`$.${name}`})) AS SIGNED), 0)`;
	const [largest] = await executor
		.select({
			owedMicroCredits: sql<
				string | number | null
			>`MAX(GREATEST(CASE WHEN ${field("chargedMicroCredits")} < ${field("owedMicroCredits")} THEN ${field("owedMicroCredits")} ELSE 0 END, ${field("outstandingMicroCredits")}))`,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.type, FIRST_MONTH_TRANSACTION_TYPE),
				openShortfall(shortSince),
			),
		);
	return Number(largest?.owedMicroCredits) || 0;
}

export async function shortfallOwed(
	executor: InfraDbExecutor,
	accountId: string,
	shortSince: Date,
) {
	const daily = await latestDailyCharge(executor, accountId);
	const dailyOwed =
		daily?.shortSince?.getTime() === shortSince.getTime() && !daily.resolvedAt
			? daily.owedMicroCredits
			: 0;
	return Math.max(
		dailyOwed,
		await firstMonthShortfallOwed(executor, accountId, shortSince),
	);
}

async function sizedShortfall(
	executor: InfraDbExecutor,
	accountId: string,
	charge: StorageCharge | null,
): Promise<StorageCharge | null> {
	if (!charge?.shortSince || charge.resolvedAt) return charge;
	return {
		...charge,
		owedMicroCredits: await shortfallOwed(
			executor,
			accountId,
			charge.shortSince,
		),
	};
}

export async function latestStorageCharge(
	executor: InfraDbExecutor,
	accountId: string,
): Promise<StorageCharge | null> {
	const firstMonth = await sizedShortfall(
		executor,
		accountId,
		await latestFirstMonthCharge(executor, accountId),
	);
	if (
		firstMonth?.shortSince &&
		!(await restoredSinceCharge(executor, accountId, firstMonth))
	) {
		return { ...firstMonth, firstMonth: true };
	}
	return sizedShortfall(
		executor,
		accountId,
		await latestDailyCharge(executor, accountId),
	);
}

export async function latchCoveredShortfall(
	tx: InfraDbExecutor,
	charge: StorageCharge | null,
	availableMicroCredits: number,
	now: Date,
	accountId: string,
) {
	if (
		!charge?.id ||
		!charge.shortSince ||
		charge.resolvedAt ||
		availableMicroCredits < charge.owedMicroCredits
	) {
		return false;
	}
	if (
		availableMicroCredits <
		(await shortfallOwed(tx, accountId, charge.shortSince))
	) {
		return false;
	}
	await tx
		.update(developerCreditTransactions)
		.set({
			metadata: sql`JSON_SET(COALESCE(${developerCreditTransactions.metadata}, JSON_OBJECT()), '$.resolvedAt', ${now.toISOString()})`,
		})
		.where(shortfallRows(accountId, charge.shortSince));
	return true;
}

export async function latestStorageCharges(
	executor: InfraDbExecutor,
	accountIds: readonly string[],
) {
	const charges = new Map<string, StorageCharge>();
	if (accountIds.length === 0) return charges;
	const ceiling = storageDayCeiling();
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
				storageDayRows(),
				sql`(${developerCreditTransactions.accountId}, ${developerCreditTransactions.referenceId}) in (select latest.accountId, latest.referenceId from (${sql.join(
					accountIds.map((accountId) => latestStorageDay(accountId, ceiling)),
					sql` union all `,
				)}) latest)`,
			),
		);
	for (const row of [...rows].sort((a, b) => (a.id < b.id ? 1 : -1))) {
		if (!charges.has(row.accountId)) {
			charges.set(row.accountId, parseStorageCharge(row));
		}
	}
	return charges;
}

const availableAfterCredit = () =>
	sql<number>`COALESCE(CAST(JSON_EXTRACT(${developerCreditTransactions.metadata}, ${`$.${AVAILABLE_AFTER_FIELD}`}) AS SIGNED), ${developerCreditTransactions.balanceAfterMicroCredits})`;

export async function restoredSinceCharge(
	executor: InfraDbExecutor,
	accountId: string,
	charge: StorageCharge,
) {
	if (charge.resolvedAt) return true;
	const [credit] = await executor
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				gt(developerCreditTransactions.createdAt, charge.createdAt),
				gt(developerCreditTransactions.amountMicroCredits, 0),
				sql`${availableAfterCredit()} >= ${charge.owedMicroCredits}`,
			),
		)
		.limit(1);
	return !!credit;
}

const disputeRows = (accountId: string | typeof developerCreditAccounts.id) =>
	and(
		eq(developerCreditTransactions.accountId, accountId),
		eq(developerCreditTransactions.type, "adjustment"),
		inArray(developerCreditTransactions.referenceType, [
			STRIPE_DISPUTE_REFERENCE_TYPE,
			DISPUTE_REVIEW_REFERENCE_TYPE,
		]),
	);

const latestDisputeOrder = () =>
	[
		desc(developerCreditTransactions.createdAt),
		desc(developerCreditTransactions.id),
	] as const;

const disputeAt = (
	referenceType: string | null | undefined,
	createdAt: Date | string | null | undefined,
) =>
	referenceType === STRIPE_DISPUTE_REFERENCE_TYPE && createdAt
		? new Date(createdAt)
		: null;

export async function disputedSince(
	executor: InfraDbExecutor,
	accountId: string,
) {
	const [latest] = await executor
		.select({
			referenceType: developerCreditTransactions.referenceType,
			createdAt: developerCreditTransactions.createdAt,
		})
		.from(developerCreditTransactions)
		.where(disputeRows(accountId))
		.orderBy(...latestDisputeOrder())
		.limit(1);
	return disputeAt(latest?.referenceType, latest?.createdAt);
}

export type StandingAccount = {
	id: string;
	balanceMicroCredits: number;
	heldMicroCredits: number;
	disputedAt: Date | null;
};

export async function readStandingAccount(
	appId: string,
	executor: InfraDbExecutor = db(),
): Promise<StandingAccount | null> {
	const latestDispute = <T>(
		column:
			| typeof developerCreditTransactions.referenceType
			| typeof developerCreditTransactions.createdAt,
	) =>
		sql<T>`(${executor
			.select({ value: column })
			.from(developerCreditTransactions)
			.where(disputeRows(developerCreditAccounts.id))
			.orderBy(...latestDisputeOrder())
			.limit(1)})`;
	const [row] = await executor
		.select({
			id: developerCreditAccounts.id,
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			heldMicroCredits: sql<
				string | number | null
			>`(${heldTranscriptsQuery(executor, appId, null)})`,
			disputeType: latestDispute<string | null>(
				developerCreditTransactions.referenceType,
			),
			disputeCreatedAt: latestDispute<Date | null>(
				developerCreditTransactions.createdAt,
			).mapWith(developerCreditTransactions.createdAt),
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		balanceMicroCredits: row.balanceMicroCredits,
		heldMicroCredits: Number(row.heldMicroCredits ?? 0) || 0,
		disputedAt: disputeAt(row.disputeType, row.disputeCreatedAt),
	};
}

export async function accountStanding(
	executor: InfraDbExecutor,
	account: {
		id: string;
		balanceMicroCredits: number;
		disputedAt?: Date | null;
	},
	now: Date,
) {
	const [lastCharge, disputedAt] = await Promise.all([
		latestStorageCharge(executor, account.id),
		account.disputedAt === undefined
			? disputedSince(executor, account.id)
			: account.disputedAt,
	]);
	if (disputedAt) {
		const standing: InfraAppStanding = {
			state: "paused",
			pausesAt: disputedAt,
			disputed: true,
		};
		return { lastCharge, standing };
	}
	const covered =
		!lastCharge?.shortSince ||
		account.balanceMicroCredits >= lastCharge.owedMicroCredits;
	const restored =
		!covered && lastCharge
			? await restoredSinceCharge(executor, account.id, lastCharge)
			: false;
	return {
		lastCharge,
		standing: resolveStanding({
			balanceMicroCredits: account.balanceMicroCredits,
			lastCharge,
			restored,
			now,
		}),
	};
}

async function appStanding(
	appId: string,
	now: Date,
	executor: InfraDbExecutor = db(),
) {
	const account = await readStandingAccount(appId, executor);
	if (!account) return { account: null, lastCharge: null, standing: ACTIVE };
	const funded = {
		id: account.id,
		balanceMicroCredits: account.balanceMicroCredits - account.heldMicroCredits,
	};
	return {
		account: funded,
		...(await accountStanding(
			executor,
			{ ...funded, disputedAt: account.disputedAt },
			now,
		)),
	};
}

export const getInfraAppStanding = cache(
	async (appId: string): Promise<InfraAppStanding> =>
		(await appStanding(appId, new Date())).standing,
);

export function uploadAdmission({
	balanceMicroCredits,
	standing,
	lastOwedMicroCredits,
	storage,
}: {
	balanceMicroCredits: number;
	standing: InfraAppStanding;
	lastOwedMicroCredits: number;
	storage: {
		dailyCharge: Pick<AppStorage["dailyCharge"], "monthlyMicroCredits">;
		firstMonthMicroCredits: number;
	};
}): InfraUploadAdmission {
	const inGoodStanding = standing.state === "active";
	const requiredMicroCredits = Math.max(
		uploadAdmissionMicroCredits(
			storage.dailyCharge.monthlyMicroCredits,
			storage.firstMonthMicroCredits,
		),
		inGoodStanding ? 0 : lastOwedMicroCredits,
	);
	const shortfallMicroCredits = Math.max(
		0,
		requiredMicroCredits - balanceMicroCredits,
	);
	const base = {
		standing,
		balanceMicroCredits,
		requiredMicroCredits,
		shortfallMicroCredits,
	};
	if (standing.disputed) {
		return {
			...base,
			allowed: false,
			reason: "out_of_credit",
			message: DISPUTED_UPLOAD_MESSAGE,
		};
	}
	const covers = uploadCreditCovers(storage);
	if (!inGoodStanding) {
		return {
			...base,
			allowed: false,
			reason: "out_of_credit",
			message: `This app is out of credit, so uploads are blocked. Add at least ${formatNeed(shortfallMicroCredits)} to upload again.`,
		};
	}
	if (shortfallMicroCredits > 0 && balanceMicroCredits <= 0) {
		return {
			...base,
			allowed: false,
			reason: "insufficient_credits",
			message: covers
				? `Not enough credit to upload. Add at least ${formatNeed(shortfallMicroCredits)}, enough for ${covers}.`
				: "Not enough credit to upload. Add credits to start uploading.",
		};
	}
	if (shortfallMicroCredits > 0) {
		return {
			...base,
			allowed: false,
			reason: "insufficient_credits",
			message: `Not enough credit to upload. Uploading needs ${formatNeed(requiredMicroCredits)}, enough for ${covers ?? "one video"}. The balance is ${formatCredits(balanceMicroCredits)}, so add at least ${formatNeed(shortfallMicroCredits)}.`,
		};
	}
	return { ...base, allowed: true, reason: null, message: null };
}

function uploadCreditCovers(storage: {
	dailyCharge: { monthlyMicroCredits: number };
	firstMonthMicroCredits: number;
}) {
	const firstMonth = storage.firstMonthMicroCredits > 0;
	const daily = storage.dailyCharge.monthlyMicroCredits > 0;
	const firstMonthText =
		"the first month of storage for each video being uploaded or encoded";
	const dailyText = `${UPLOAD_ADMISSION_DAYS} days of storage for the videos past their first month`;
	if (firstMonth && daily) return `${firstMonthText} and ${dailyText}`;
	if (firstMonth) return firstMonthText;
	return daily ? dailyText : null;
}

export async function getInfraBilling(
	appId: string,
	newVideo?: BillableVideo | null,
	now: Date = new Date(),
	executor?: InfraDbExecutor,
	options: { excludeVideoId?: string; storage?: AppStorage } = {},
) {
	const [{ account, lastCharge, standing }, storage] = executor
		? [
				await appStanding(appId, now, executor),
				options.storage ??
					(await getAppStorage(appId, newVideo, executor, { ...options, now })),
			]
		: await Promise.all([
				appStanding(appId, now),
				options.storage ??
					getAppStorage(appId, newVideo, undefined, { ...options, now }),
			]);
	const admission = uploadAdmission({
		balanceMicroCredits: account?.balanceMicroCredits ?? 0,
		standing,
		lastOwedMicroCredits: lastCharge?.owedMicroCredits ?? 0,
		storage,
	});
	return {
		standing,
		storage,
		stored: storage.stored,
		admission: account
			? admission
			: {
					...admission,
					allowed: false,
					reason: "no_account" as const,
					message: "Credit account not found",
				},
	};
}

export async function getInfraUploadAdmission(
	appId: string,
	newVideo?: BillableVideo | null,
	executor?: InfraDbExecutor,
	options: { excludeVideoId?: string; storage?: AppStorage } = {},
): Promise<InfraUploadAdmission> {
	return (await getInfraBilling(appId, newVideo, new Date(), executor, options))
		.admission;
}

export function infraStorageJson(storage: AppStorage) {
	return {
		minutesByTier: storage.stored.minutesByTier,
		dailyChargeMinutesByTier: storage.dailyCharge.minutesByTier,
		dailyMicroCredits: storage.dailyCharge.dailyMicroCredits,
		monthlyMicroCredits: Math.round(storage.dailyCharge.monthlyMicroCredits),
	};
}

export function infraBillingJson({
	standing,
	storage,
	admission,
}: Awaited<ReturnType<typeof getInfraBilling>>) {
	return {
		standing: {
			state: standing.state,
			pausesAt: standing.pausesAt?.toISOString() ?? null,
		},
		upload: {
			allowed: admission.allowed,
			reason: admission.reason,
			requiredMicroCredits: admission.requiredMicroCredits,
			shortfallMicroCredits: admission.shortfallMicroCredits,
			message: admission.message,
		},
		storage: infraStorageJson(storage),
	};
}

export function uploadAdmissionError(admission: InfraUploadAdmission) {
	return {
		error:
			admission.reason === "no_account"
				? "Credit account not found"
				: "Insufficient credits",
		code: admission.reason ?? "insufficient_credits",
		message: admission.message ?? "Insufficient credits",
		standing: admission.standing.state,
		pausesAt: admission.standing.pausesAt?.toISOString() ?? null,
		balanceMicroCredits: admission.balanceMicroCredits,
		requiredMicroCredits: admission.requiredMicroCredits,
		shortfallMicroCredits: admission.shortfallMicroCredits,
	};
}
