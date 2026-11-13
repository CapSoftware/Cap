import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
	type BillableVideo,
	billableVideo,
	type StorageUsage,
	storageUsage,
} from "@/lib/developer-pricing";
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
};

const APP_ID_CHUNK = 500;

export type StorageUsageOptions = {
	includeProcessing?: boolean;
	excludeVideoId?: string;
	dailyChargeAt?: Date;
};

export function storedVideoGroupsQuery(
	appIds: readonly string[],
	executor: Pick<InfraDbExecutor, "select">,
	excludeVideoId?: string,
	now: Date = new Date(),
) {
	const inFirstMonth = gt(developerVideos.storagePaidUntil, now);
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
		})
		.from(developerVideos)
		.where(
			and(
				inArray(developerVideos.appId, [...appIds]),
				isNull(developerVideos.deletedAt),
				excludeVideoId ? ne(developerVideos.id, excludeVideoId) : undefined,
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
) {
	const groups: StoredVideoGroup[] = [];
	for (let start = 0; start < appIds.length; start += APP_ID_CHUNK) {
		groups.push(
			...(await storedVideoGroupsQuery(
				appIds.slice(start, start + APP_ID_CHUNK),
				executor,
				excludeVideoId,
				now,
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
	firstMonthDue: StorageUsage;
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
	);
	const usage = (
		status: "ready" | "processing",
		daily: boolean,
		extra: BillableVideo | null = null,
	) =>
		storageUsage([
			...groups
				.filter((group) => group.status === status)
				.map((group) => ({
					video: billableVideo({
						duration: Number(daily ? group.dailySeconds : group.seconds),
						width: group.width,
						height: group.height,
						maxResolutionTier: group.maxResolutionTier,
					}),
					count: Number(daily ? group.dailyCount : group.count) || 0,
				})),
			...(extra ? [{ video: extra, count: 1 }] : []),
		]);
	return {
		stored: usage("ready", false),
		dailyCharge: usage("ready", true),
		firstMonthDue: usage("processing", false, newVideo),
		uploadingVideos: groups.reduce(
			(sum, group) =>
				sum + (Number(group.rows) || 0) - (Number(group.count) || 0),
			0,
		),
	};
}
