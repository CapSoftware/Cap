import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import {
	and,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	type BillableVideo,
	billableVideo,
	firstMonthStorageMicroCredits,
	STORAGE_BILLING_DAYS_PER_MONTH,
	type StorageUsage,
	storageMicroCreditsPerMinutePerMonth,
	storageUsage,
} from "@/lib/developer-pricing";
import type { InfraResolutionTier } from "@/lib/infra-pricing";
import type { InfraDbExecutor } from "@/lib/infra-standing";

type StoredVideoGroup = {
	appId: string;
	width: number | null;
	height: number | null;
	status: string;
	maxResolutionTier: string | null;
	seconds: number | string | null;
	count: number | string;
	rows: number | string;
	dailySeconds: number | string | null;
	dailyCount: number | string | null;
	firstMonth1080p: number | string | null;
	firstMonth1440p: number | string | null;
	firstMonth2160p: number | string | null;
	owedFirstMonth1080p: number | string | null;
	owedFirstMonth1440p: number | string | null;
	owedFirstMonth2160p: number | string | null;
};

const firstMonthSum = (tier: InfraResolutionTier) =>
	sql<
		number | string | null
	>`COALESCE(SUM(GREATEST(1, FLOOR(${developerVideos.duration} / 60 * ${storageMicroCreditsPerMinutePerMonth(tier)}))), 0)`;

const owedFirstMonthSum = (tier: InfraResolutionTier, owesMonth: SQL) =>
	sql<
		number | string | null
	>`COALESCE(SUM(CASE WHEN ${owesMonth} THEN GREATEST(1, FLOOR(${developerVideos.duration} / 60 * ${storageMicroCreditsPerMinutePerMonth(tier)})) ELSE 0 END), 0)`;

const APP_ID_CHUNK = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

async function firstMonthsOwedSince(executor: Pick<InfraDbExecutor, "select">) {
	const [earliest] = await executor
		.select({
			storagePaidUntil:
				sql<Date | null>`MIN(${developerVideos.storagePaidUntil})`.mapWith(
					developerVideos.storagePaidUntil,
				),
		})
		.from(developerVideos)
		.where(isNotNull(developerVideos.storagePaidUntil));
	const paidUntil = earliest?.storagePaidUntil;
	return paidUntil instanceof Date && !Number.isNaN(paidUntil.getTime())
		? new Date(
				paidUntil.getTime() - (STORAGE_BILLING_DAYS_PER_MONTH - 1) * DAY_MS,
			)
		: null;
}

export type StorageUsageOptions = {
	includeProcessing?: boolean;
	excludeVideoId?: string;
	dailyChargeAt?: Date;
	createdBefore?: Date;
};

export function storedVideoGroupsQuery(
	appIds: readonly string[],
	executor: Pick<InfraDbExecutor, "select">,
	excludeVideoId?: string,
	now: Date = new Date(),
	createdBefore?: Date,
	firstMonthsOwedSince?: Date | null,
) {
	const owesMonth = firstMonthsOwedSince
		? sql`(${developerVideos.status} = 'ready' AND ${developerVideos.storagePaidUntil} IS NULL AND ${developerVideos.createdAt} >= ${firstMonthsOwedSince})`
		: sql`FALSE`;
	const inFirstMonth = sql`(${gt(developerVideos.storagePaidUntil, now)} OR ${owesMonth})`;
	return executor
		.select({
			appId: developerVideos.appId,
			width: developerVideos.width,
			height: developerVideos.height,
			status: developerVideos.status,
			maxResolutionTier: developerVideos.maxResolutionTier,
			seconds: sql<
				number | string | null
			>`COALESCE(SUM(${developerVideos.duration}), 0)`,
			count: sql<number | string>`COUNT(${developerVideos.duration})`,
			rows: sql<number | string>`COUNT(*)`,
			dailySeconds: sql<
				number | string | null
			>`COALESCE(SUM(CASE WHEN ${inFirstMonth} THEN 0 ELSE ${developerVideos.duration} END), 0)`,
			dailyCount: sql<
				number | string | null
			>`COALESCE(SUM(CASE WHEN ${inFirstMonth} THEN 0 WHEN ${developerVideos.duration} IS NULL THEN 0 ELSE 1 END), 0)`,
			firstMonth1080p: firstMonthSum("1080p"),
			firstMonth1440p: firstMonthSum("1440p"),
			firstMonth2160p: firstMonthSum("2160p"),
			owedFirstMonth1080p: owedFirstMonthSum("1080p", owesMonth),
			owedFirstMonth1440p: owedFirstMonthSum("1440p", owesMonth),
			owedFirstMonth2160p: owedFirstMonthSum("2160p", owesMonth),
		})
		.from(developerVideos)
		.where(
			and(
				inArray(developerVideos.appId, [...appIds]),
				isNull(developerVideos.deletedAt),
				excludeVideoId ? ne(developerVideos.id, excludeVideoId) : undefined,
				createdBefore
					? lt(developerVideos.createdAt, createdBefore)
					: undefined,
			),
		)
		.groupBy(
			developerVideos.appId,
			developerVideos.status,
			developerVideos.maxResolutionTier,
			developerVideos.width,
			developerVideos.height,
		);
}

async function storedVideoGroups(
	appIds: readonly string[],
	executor: InfraDbExecutor,
	excludeVideoId?: string,
	now?: Date,
	createdBefore?: Date,
	firstMonthsOwedSince?: Date | null,
) {
	const groups: StoredVideoGroup[] = [];
	for (let start = 0; start < appIds.length; start += APP_ID_CHUNK) {
		groups.push(
			...(await storedVideoGroupsQuery(
				appIds.slice(start, start + APP_ID_CHUNK),
				executor,
				excludeVideoId,
				now,
				createdBefore,
				firstMonthsOwedSince,
			)),
		);
	}
	return groups;
}

export async function getStorageUsageByApp(
	appIds: readonly string[],
	extra?: { appId: string; video: BillableVideo | null },
	executor: InfraDbExecutor = db(),
	options: StorageUsageOptions = {},
) {
	const entriesByApp = new Map<
		string,
		{ video: BillableVideo | null; count: number }[]
	>();
	for (const appId of appIds) entriesByApp.set(appId, []);
	if (appIds.length > 0) {
		const daily = options.dailyChargeAt !== undefined;
		for (const group of await storedVideoGroups(
			appIds,
			executor,
			options.excludeVideoId,
			options.dailyChargeAt,
			options.createdBefore,
		)) {
			entriesByApp.get(group.appId)?.push({
				video: billableVideo({
					duration: Number(daily ? group.dailySeconds : group.seconds),
					width: group.width,
					height: group.height,
					status: group.status,
					maxResolutionTier: group.maxResolutionTier,
					includeProcessing: options.includeProcessing,
				}),
				count: Number(daily ? group.dailyCount : group.count) || 0,
			});
		}
	}
	if (extra) {
		entriesByApp.get(extra.appId)?.push({ video: extra.video, count: 1 });
	}
	const usageByApp = new Map<string, StorageUsage>();
	for (const [appId, entries] of entriesByApp) {
		usageByApp.set(appId, storageUsage(entries));
	}
	return usageByApp;
}

export async function getAppStorageUsage(
	appId: string,
	newVideo?: BillableVideo | null,
	executor: InfraDbExecutor = db(),
	options: StorageUsageOptions = {},
): Promise<StorageUsage> {
	const usageByApp = await getStorageUsageByApp(
		[appId],
		newVideo ? { appId, video: newVideo } : undefined,
		executor,
		options,
	);
	return usageByApp.get(appId) ?? storageUsage([]);
}

export type AppStorage = {
	stored: StorageUsage;
	dailyCharge: StorageUsage;
	firstMonthMicroCredits: number;
	uploadingVideos: number;
};

export async function getAppStorage(
	appId: string,
	newVideo?: BillableVideo | null,
	executor: InfraDbExecutor = db(),
	options: { excludeVideoId?: string; now?: Date } = {},
): Promise<AppStorage> {
	const groups = await storedVideoGroups(
		[appId],
		executor,
		options.excludeVideoId,
		options.now,
		undefined,
		await firstMonthsOwedSince(executor),
	);
	const videoOf = (group: StoredVideoGroup, daily: boolean) =>
		billableVideo({
			duration: Number(daily ? group.dailySeconds : group.seconds),
			width: group.width,
			height: group.height,
			maxResolutionTier: group.maxResolutionTier,
		});
	const ready = groups.filter((group) => group.status === "ready");
	const usage = (daily: boolean) =>
		storageUsage(
			ready.map((group) => ({
				video: videoOf(group, daily),
				count: Number(daily ? group.dailyCount : group.count) || 0,
			})),
		);
	const firstMonthOf = (group: StoredVideoGroup) => {
		const video = videoOf(group, false);
		if (!video) return 0;
		return group.status === "processing"
			? Number(group[`firstMonth${video.tier}`]) || 0
			: Number(group[`owedFirstMonth${video.tier}`]) || 0;
	};
	return {
		stored: usage(false),
		dailyCharge: usage(true),
		firstMonthMicroCredits:
			groups
				.filter(
					(group) => group.status === "processing" || group.status === "ready",
				)
				.reduce((sum, group) => sum + firstMonthOf(group), 0) +
			(newVideo ? firstMonthStorageMicroCredits(newVideo) : 0),
		uploadingVideos: groups.reduce(
			(sum, group) =>
				sum + (Number(group.rows) || 0) - (Number(group.count) || 0),
			0,
		),
	};
}
