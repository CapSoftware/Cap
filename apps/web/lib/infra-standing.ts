import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, desc, eq, gt, gte } from "drizzle-orm";
import { cache } from "react";
import {
	type BillableVideo,
	UPLOAD_ADMISSION_DAYS,
	uploadAdmissionMicroCredits,
} from "@/lib/developer-pricing";
import { availableBalance } from "@/lib/infra-balance";
import { type AppStorage, getAppStorage } from "@/lib/infra-storage";
import { formatCredits, formatNeed } from "@/lib/infra-usage";

export const INFRA_GRACE_DAYS = 7;
export const STORAGE_DAY_REFERENCE_TYPE = "storage_day" as const;
export const FIRST_MONTH_TRANSACTION_TYPE = "video_create" as const;
export const FIRST_MONTH_REFERENCE_TYPE = "developer_video" as const;

const GRACE_MS = INFRA_GRACE_DAYS * 24 * 60 * 60 * 1000;

export type InfraStandingState = "active" | "grace" | "paused";

export type InfraAppStanding = {
	state: InfraStandingState;
	pausesAt: Date | null;
};

export type StorageCharge = {
	createdAt: Date;
	owedMicroCredits: number;
	shortSince: Date | null;
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

async function latestChargeOfType(
	executor: InfraDbExecutor,
	accountId: string,
	type: "storage_daily",
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
				eq(developerCreditTransactions.type, type),
			),
		)
		.orderBy(desc(developerCreditTransactions.createdAt))
		.limit(1);
	return row ? parseStorageCharge(row) : null;
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
	return (
		sameSecond.find((charge) => charge.shortSince) ?? sameSecond[0] ?? null
	);
}

export async function latestStorageCharge(
	executor: InfraDbExecutor,
	accountId: string,
): Promise<StorageCharge | null> {
	const daily = await latestChargeOfType(executor, accountId, "storage_daily");
	const firstMonth = await latestFirstMonthCharge(executor, accountId);
	if (
		firstMonth?.shortSince &&
		(!daily || firstMonth.createdAt.getTime() >= daily.createdAt.getTime())
	) {
		return { ...firstMonth, firstMonth: true };
	}
	return daily;
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

export async function accountStanding(
	executor: InfraDbExecutor,
	account: { id: string; balanceMicroCredits: number },
	now: Date,
) {
	const lastCharge = await latestStorageCharge(executor, account.id);
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
	const [account] = await executor
		.select({
			id: developerCreditAccounts.id,
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.limit(1);
	if (!account) return { account: null, lastCharge: null, standing: ACTIVE };
	const funded = {
		id: account.id,
		balanceMicroCredits: (await availableBalance(appId, executor)) ?? 0,
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
	options: { excludeVideoId?: string } = {},
) {
	const counted = { ...options, now };
	const [{ account, lastCharge, standing }, storage] = executor
		? [
				await appStanding(appId, now, executor),
				await getAppStorage(appId, newVideo, executor, counted),
			]
		: await Promise.all([
				appStanding(appId, now),
				getAppStorage(appId, newVideo, undefined, counted),
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
	options: { excludeVideoId?: string } = {},
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
