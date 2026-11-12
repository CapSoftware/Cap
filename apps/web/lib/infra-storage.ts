import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
	type BillableVideo,
	billableVideo,
	type StorageUsage,
	storageUsage,
} from "@/lib/developer-pricing";

type StoredVideoGroup = {
	appId: string;
	width: number | null;
	height: number | null;
	seconds: number | string | null;
	count: number | string;
};

const APP_ID_CHUNK = 500;

async function storedVideoGroups(appIds: readonly string[]) {
	const groups: StoredVideoGroup[] = [];
	for (let start = 0; start < appIds.length; start += APP_ID_CHUNK) {
		const rows = await db()
			.select({
				appId: developerVideos.appId,
				width: developerVideos.width,
				height: developerVideos.height,
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
				),
			)
			.groupBy(
				developerVideos.appId,
				developerVideos.width,
				developerVideos.height,
			);
		groups.push(...rows);
	}
	return groups;
}

export async function getStorageUsageByApp(
	appIds: readonly string[],
	extra?: { appId: string; video: BillableVideo | null },
) {
	const entriesByApp = new Map<
		string,
		{ video: BillableVideo | null; count: number }[]
	>();
	for (const appId of appIds) entriesByApp.set(appId, []);
	if (appIds.length > 0) {
		for (const group of await storedVideoGroups(appIds)) {
			entriesByApp.get(group.appId)?.push({
				video: billableVideo({
					duration: Number(group.seconds),
					width: group.width,
					height: group.height,
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
): Promise<StorageUsage> {
	const usageByApp = await getStorageUsageByApp(
		[appId],
		newVideo ? { appId, video: newVideo } : undefined,
	);
	return usageByApp.get(appId) ?? storageUsage([]);
}
