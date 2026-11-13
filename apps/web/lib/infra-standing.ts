import { db } from "@cap/database";
import { developerCreditTransactions } from "@cap/database/schema";
import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { cache } from "react";
import {
	type BillableVideo,
	type StorageUsage,
	UPLOAD_ADMISSION_DAYS,
	uploadAdmissionMicroCredits,
} from "@/lib/developer-pricing";
import { accountWithAvailableBalance } from "@/lib/infra-balance";
import { type AppStorage, getAppStorage } from "@/lib/infra-storage";
import { formatCredits, formatNeed, utcDateKey } from "@/lib/infra-usage";

export const INFRA_GRACE_DAYS = 7;
export const STORAGE_DAY_REFERENCE_TYPE = "storage_day" as const;
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
	createdAt: Date;
	owedMicroCredits: number;
	shortSince: Date | null;
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

export function parseStorageCharge(row: {
	createdAt: Date;
	metadata: unknown;
}): StorageCharge {
	const fields = metadataFields(row.metadata);
	const shortSince =
		typeof fields.shortSince === "string" ? new Date(fields.shortSince) : null;
	return {
		createdAt: new Date(row.createdAt),
		owedMicroCredits: Math.max(0, Number(fields.owedMicroCredits) || 0),
		shortSince:
			shortSince && !Number.isNaN(shortSince.getTime()) ? shortSince : null,
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

export async function latestStorageCharge(
	executor: InfraDbExecutor,
	accountId: string,
) {
	const [row] = await executor
		.select({
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
	return row ? parseStorageCharge(row) : null;
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

export async function restoredSinceCharge(
	executor: InfraDbExecutor,
	accountId: string,
	charge: StorageCharge,
) {
	const [credit] = await executor
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				gte(developerCreditTransactions.createdAt, charge.createdAt),
				gt(developerCreditTransactions.amountMicroCredits, 0),
				gte(
					developerCreditTransactions.balanceAfterMicroCredits,
					charge.owedMicroCredits,
				),
			),
		)
		.limit(1);
	return !!credit;
}

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
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.type, "adjustment"),
				inArray(developerCreditTransactions.referenceType, [
					STRIPE_DISPUTE_REFERENCE_TYPE,
					DISPUTE_REVIEW_REFERENCE_TYPE,
				]),
			),
		)
		.orderBy(desc(developerCreditTransactions.createdAt))
		.limit(1);
	return latest?.referenceType === STRIPE_DISPUTE_REFERENCE_TYPE
		? new Date(latest.createdAt)
		: null;
}

export async function accountStanding(
	executor: InfraDbExecutor,
	account: { id: string; balanceMicroCredits: number },
	now: Date,
) {
	const [lastCharge, disputedAt] = await Promise.all([
		latestStorageCharge(executor, account.id),
		disputedSince(executor, account.id),
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
	const account = await accountWithAvailableBalance(appId, executor);
	if (!account) return { account: null, lastCharge: null, standing: ACTIVE };
	const funded = {
		id: account.id,
		balanceMicroCredits: account.availableMicroCredits,
	};
	return {
		account: funded,
		...(await accountStanding(executor, funded, now)),
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
	usage,
}: {
	balanceMicroCredits: number;
	standing: InfraAppStanding;
	lastOwedMicroCredits: number;
	usage: Pick<StorageUsage, "monthlyMicroCredits">;
}): InfraUploadAdmission {
	const inGoodStanding = standing.state === "active";
	const requiredMicroCredits = Math.max(
		uploadAdmissionMicroCredits(usage.monthlyMicroCredits),
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
			message:
				usage.monthlyMicroCredits > 0
					? `This app has no credit. Add at least ${formatNeed(shortfallMicroCredits)} to upload, enough for ${UPLOAD_ADMISSION_DAYS} days of storage for everything it stores.`
					: "This app has no credit. Add credits to start uploading.",
		};
	}
	if (shortfallMicroCredits > 0) {
		return {
			...base,
			allowed: false,
			reason: "insufficient_credits",
			message: `Uploading needs ${formatNeed(requiredMicroCredits)} of credit, enough for ${UPLOAD_ADMISSION_DAYS} days of storage for everything this app stores. The balance is ${formatCredits(balanceMicroCredits)}, so add at least ${formatNeed(shortfallMicroCredits)}.`,
		};
	}
	return { ...base, allowed: true, reason: null, message: null };
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
					(await getAppStorage(appId, newVideo, executor, options)),
			]
		: await Promise.all([
				appStanding(appId, now),
				options.storage ?? getAppStorage(appId, newVideo, undefined, options),
			]);
	const usage = storage.counted;
	const admission = uploadAdmission({
		balanceMicroCredits: account?.balanceMicroCredits ?? 0,
		standing,
		lastOwedMicroCredits: lastCharge?.owedMicroCredits ?? 0,
		usage,
	});
	return {
		standing,
		usage,
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

export function infraStorageJson(
	usage: Pick<
		StorageUsage,
		"minutesByTier" | "dailyMicroCredits" | "monthlyMicroCredits"
	>,
) {
	return {
		minutesByTier: usage.minutesByTier,
		dailyMicroCredits: usage.dailyMicroCredits,
		monthlyMicroCredits: Math.round(usage.monthlyMicroCredits),
	};
}

export function infraBillingJson({
	standing,
	usage,
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
		storage: infraStorageJson(usage),
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
