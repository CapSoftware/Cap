import { db } from "@cap/database";
import {
	getCurrentUser,
	type userSelectProps,
} from "@cap/database/auth/session";
import { decrypt } from "@cap/database/crypto";
import {
	developerApiKeys,
	developerAppDomains,
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
	developerVideos,
	organizations,
} from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { canUseInfra } from "@/lib/infra-access";
import { hasClaimedProCredit, nextProCreditDate } from "@/lib/infra-pro-credit";
import { INFRA_APP_COOKIE, selectInfraApp } from "@/lib/infra-routes";
import type { InfraStorageSnapshot } from "@/lib/infra-usage";

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

export type InfraAppSummary = {
	id: string;
	name: string;
	environment: DeveloperApp["environment"];
	balanceMicroCredits: number;
};

export async function getDeveloperApps(
	user: Pick<typeof userSelectProps, "id">,
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

	const decryptedPublicKeys = new Map<string, string>();
	for (const k of allApiKeys) {
		if (k.keyType === "public" && k.encryptedKey) {
			try {
				decryptedPublicKeys.set(k.id, await decrypt(k.encryptedKey));
			} catch {
				decryptedPublicKeys.set(k.id, `${k.keyPrefix}...`);
			}
		}
	}

	const domainsByApp = new Map<string, (typeof allDomains)[number][]>();
	for (const d of allDomains) {
		const list = domainsByApp.get(d.appId) ?? [];
		list.push(d);
		domainsByApp.set(d.appId, list);
	}

	const keysByApp = new Map<string, (typeof allApiKeys)[number][]>();
	for (const k of allApiKeys) {
		const list = keysByApp.get(k.appId) ?? [];
		list.push(k);
		keysByApp.set(k.appId, list);
	}

	const accountsByApp = new Map(allCreditAccounts.map((c) => [c.appId, c]));
	const countsByApp = new Map(allVideoCounts.map((v) => [v.appId, v.count]));

	return apps.map((app) => ({
		...app,
		domains: domainsByApp.get(app.id) ?? [],
		apiKeys: (keysByApp.get(app.id) ?? []).map((k) => ({
			id: k.id,
			keyType: k.keyType,
			keyPrefix: k.keyPrefix,
			createdAt: k.createdAt,
			revokedAt: k.revokedAt,
			fullKey:
				k.keyType === "public"
					? (decryptedPublicKeys.get(k.id) ?? `${k.keyPrefix}...`)
					: undefined,
		})),
		creditAccount: accountsByApp.get(app.id) ?? null,
		videoCount: countsByApp.get(app.id) ?? 0,
	}));
}

export type InfraVideoRow = Pick<
	typeof developerVideos.$inferSelect,
	| "id"
	| "name"
	| "externalUserId"
	| "duration"
	| "width"
	| "height"
	| "createdAt"
>;

export async function getDeveloperAppVideos(
	appId: string,
	options?: { userId?: string; limit?: number; offset?: number },
): Promise<InfraVideoRow[]> {
	const conditions = [
		eq(developerVideos.appId, appId),
		isNull(developerVideos.deletedAt),
	];

	if (options?.userId) {
		conditions.push(eq(developerVideos.externalUserId, options.userId));
	}

	return db()
		.select({
			id: developerVideos.id,
			name: developerVideos.name,
			externalUserId: developerVideos.externalUserId,
			duration: developerVideos.duration,
			width: developerVideos.width,
			height: developerVideos.height,
			createdAt: developerVideos.createdAt,
		})
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
		totalVideos: Number(videoStats?.totalVideos ?? 0),
		totalDurationMinutes: Number(videoStats?.totalDurationMinutes ?? 0) || 0,
	};
}

const getInfraAppsForUser = cache((userId: (typeof userSelectProps)["id"]) =>
	getDeveloperApps({ id: userId }),
);

async function requireInfraUser() {
	const user = await getCurrentUser();
	if (!user) redirect("/login");
	if (!canUseInfra(user.email)) notFound();
	return user;
}

export async function getInfraOrganizations() {
	const user = await requireInfraUser();
	const rows = await db()
		.select({ id: organizations.id, name: organizations.name })
		.from(organizations)
		.where(
			and(
				eq(organizations.ownerId, user.id),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(6);
	return rows.sort(
		(a, b) =>
			Number(b.id === user.activeOrganizationId) -
			Number(a.id === user.activeOrganizationId),
	);
}

export type InfraProCredit = {
	status: "available" | "claimed" | "not_pro";
	nextDate: string;
};

export async function getInfraProCredit(): Promise<InfraProCredit> {
	const user = await requireInfraUser();
	const now = new Date();
	const nextDate = nextProCreditDate(now).toISOString();
	if (!userIsPro(user)) return { status: "not_pro", nextDate };
	const claimed = await hasClaimedProCredit(user.id, now);
	return { status: claimed ? "claimed" : "available", nextDate };
}

export async function getInfraApps() {
	const user = await requireInfraUser();
	return getInfraAppsForUser(user.id);
}

export async function getSelectedInfraApp() {
	const [apps, cookieStore] = await Promise.all([getInfraApps(), cookies()]);
	return selectInfraApp(apps, cookieStore.get(INFRA_APP_COOKIE)?.value);
}

export async function requireInfraApp(appId: string) {
	const apps = await getInfraApps();
	const app = apps.find((a) => a.id === appId);
	if (!app) notFound();
	return { app, apps };
}

export function toInfraAppSummary(app: DeveloperApp): InfraAppSummary {
	return {
		id: app.id,
		name: app.name,
		environment: app.environment,
		balanceMicroCredits: app.creditAccount?.balanceMicroCredits ?? 0,
	};
}

export async function getInfraStorageSnapshots(
	appId: string,
	sinceDateKey: string,
): Promise<InfraStorageSnapshot[]> {
	const rows = await db()
		.select({
			snapshotDate: developerDailyStorageSnapshots.snapshotDate,
			totalDurationMinutes: developerDailyStorageSnapshots.totalDurationMinutes,
			videoCount: developerDailyStorageSnapshots.videoCount,
			microCreditsCharged: developerDailyStorageSnapshots.microCreditsCharged,
		})
		.from(developerDailyStorageSnapshots)
		.where(
			and(
				eq(developerDailyStorageSnapshots.appId, appId),
				gte(developerDailyStorageSnapshots.snapshotDate, sinceDateKey),
			),
		)
		.orderBy(desc(developerDailyStorageSnapshots.snapshotDate));

	return rows.map((row) => ({
		snapshotDate: row.snapshotDate,
		totalDurationMinutes: Number(row.totalDurationMinutes) || 0,
		videoCount: Number(row.videoCount) || 0,
		microCreditsCharged: Number(row.microCreditsCharged) || 0,
	}));
}

export async function getInfraStorageChargesSince(
	accountId: string,
	since: Date,
) {
	const [row] = await db()
		.select({
			total: sql<
				string | number | null
			>`COALESCE(SUM(-${developerCreditTransactions.amountMicroCredits}), 0)`,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.type, "storage_daily"),
				gte(developerCreditTransactions.createdAt, since),
			),
		);

	return Number(row?.total ?? 0) || 0;
}
