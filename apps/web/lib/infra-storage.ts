import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
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
};

const APP_ID_CHUNK = 500;

export type StorageUsageOptions = {
	includeProcessing?: boolean;
	excludeVideoId?: string;
};

async function storedVideoGroups(
	appIds: readonly string[],
	executor: InfraDbExecutor,
	excludeVideoId?: string,
) {
	const groups: StoredVideoGroup[] = [];
	for (let start = 0; start < appIds.length; start += APP_ID_CHUNK) {
		const rows = await executor
			.select({
				appId: developerVideos.appId,
				width: developerVideos.width,
				height: developerVideos.height,
				status: developerVideos.status,
				maxResolutionTier: developerVideos.maxResolutionTier,
				seconds: sql<
					number | string | null
				>`COALESCE(SUM(${developerVideos.duration}), 0)`,
				count: sql<number | string>`COUNT(*)`,
			})
			.from(developerVideos)
			.where(
				and(
					inArray(
						developerVideos.appId,
						appIds.slice(start, start + APP_ID_CHUNK),
					),
					isNull(developerVideos.deletedAt),
					isNotNull(developerVideos.duration),
					excludeVideoId ? ne(developerVideos.id, excludeVideoId) : undefined,
				),
			)
			.groupBy(
				developerVideos.appId,
				developerVideos.width,
				developerVideos.height,
				developerVideos.status,
				developerVideos.maxResolutionTier,
			);
		groups.push(...rows);
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
		for (const group of await storedVideoGroups(
			appIds,
			executor,
			options.excludeVideoId,
		)) {
			entriesByApp.get(group.appId)?.push({
				video: billableVideo({
					duration: Number(group.seconds),
					width: group.width,
					height: group.height,
					status: group.status,
					maxResolutionTier: group.maxResolutionTier,
					includeProcessing: options.includeProcessing,
				}),
				count: Number(group.count) || 0,
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
