import { db } from "@cap/database";
import type { userSelectProps } from "@cap/database/auth/session";
import {
	developerApiKeys,
	developerAppDomains,
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerVideos,
} from "@cap/database/schema";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

export type DeveloperApiKey = Pick<
	typeof developerApiKeys.$inferSelect,
	"id" | "keyType" | "keyPrefix" | "createdAt" | "revokedAt"
> & {
	fullKey?: string;
};

export type DeveloperApp = typeof developerApps.$inferSelect & {
	domains: (typeof developerAppDomains.$inferSelect)[];
	apiKeys: DeveloperApiKey[];
	creditAccount: typeof developerCreditAccounts.$inferSelect | null;
	videoCount: number;
};

export type DeveloperTransaction =
	typeof developerCreditTransactions.$inferSelect;

export async function getDeveloperApps(
	user: typeof userSelectProps,
): Promise<DeveloperApp[]> {
	const apps = await db()
		.select()
		.from(developerApps)
		.where(
			and(eq(developerApps.ownerId, user.id), isNull(developerApps.deletedAt)),
		)
		.orderBy(desc(developerApps.createdAt));

	if (apps.length === 0) return [];

	const appIds = apps.map((a) => a.id);

	const [allDomains, allApiKeys, allCreditAccounts, allVideoCounts] =
		await Promise.all([
			db()
				.select()
				.from(developerAppDomains)
				.where(inArray(developerAppDomains.appId, appIds)),
			db()
				.select({
					id: developerApiKeys.id,
					appId: developerApiKeys.appId,
					keyType: developerApiKeys.keyType,
					keyPrefix: developerApiKeys.keyPrefix,
					encryptedKey: developerApiKeys.encryptedKey,
					createdAt: developerApiKeys.createdAt,
					revokedAt: developerApiKeys.revokedAt,
				})
				.from(developerApiKeys)
				.where(
					and(
						inArray(developerApiKeys.appId, appIds),
						isNull(developerApiKeys.revokedAt),
					),
				),
			db()
				.select()
				.from(developerCreditAccounts)
				.where(inArray(developerCreditAccounts.appId, appIds)),
			db()
				.select({
					appId: developerVideos.appId,
					count: count(),
				})
				.from(developerVideos)
				.where(
					and(
						inArray(developerVideos.appId, appIds),
						isNull(developerVideos.deletedAt),
					),
				)
				.groupBy(developerVideos.appId),
		]);

	return apps.map((app) => ({
		...app,
		domains: allDomains.filter((d) => d.appId === app.id),
		apiKeys: allApiKeys
			.filter((k) => k.appId === app.id)
			.map((k) => ({
				id: k.id,
				keyType: k.keyType,
				keyPrefix: k.keyPrefix,
				createdAt: k.createdAt,
				revokedAt: k.revokedAt,
				fullKey: k.keyType === "public" ? k.encryptedKey : undefined,
			})),
		creditAccount: allCreditAccounts.find((c) => c.appId === app.id) ?? null,
		videoCount: allVideoCounts.find((v) => v.appId === app.id)?.count ?? 0,
	}));
}

export async function getDeveloperAppVideos(
	appId: string,
	options?: { userId?: string; limit?: number; offset?: number },
) {
	const conditions = [
		eq(developerVideos.appId, appId),
		isNull(developerVideos.deletedAt),
	];

	if (options?.userId) {
		conditions.push(eq(developerVideos.externalUserId, options.userId));
	}

	return db()
		.select()
		.from(developerVideos)
		.where(and(...conditions))
		.orderBy(desc(developerVideos.createdAt))
		.limit(options?.limit ?? 50)
		.offset(options?.offset ?? 0);
}

export async function getDeveloperTransactions(accountId: string, limit = 50) {
	return db()
		.select()
		.from(developerCreditTransactions)
		.where(eq(developerCreditTransactions.accountId, accountId))
		.orderBy(desc(developerCreditTransactions.createdAt))
		.limit(limit);
}

export async function getDeveloperUsageSummary(appId: string) {
	const [videoStats] = await db()
		.select({
			totalVideos: count(),
			totalDurationMinutes: sql<number>`COALESCE(SUM(${developerVideos.duration}) / 60, 0)`,
		})
		.from(developerVideos)
		.where(
			and(eq(developerVideos.appId, appId), isNull(developerVideos.deletedAt)),
		);

	return {
		totalVideos: videoStats?.totalVideos ?? 0,
		totalDurationMinutes: videoStats?.totalDurationMinutes ?? 0,
	};
}
