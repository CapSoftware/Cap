import { db } from "@cap/database";
import {
	getCurrentUser,
	type userSelectProps,
} from "@cap/database/auth/session";
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
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { exactUserIdMatch } from "@/lib/developer-user-scope";
import {
	developerVideoPageUrls,
	developerVideoPlaybackUrls,
} from "@/lib/developer-video-api";
import { redriveDeveloperVideoProcessing } from "@/lib/developer-video-start";
import { developerVideoRedrive } from "@/lib/developer-video-state";
import { canUseInfra } from "@/lib/infra-access";
import { hasClaimedProCredit, nextProCreditDate } from "@/lib/infra-pro-credit";
import {
	INFRA_APP_COOKIE,
	INFRA_BASE_PATH,
	INFRA_PATH_HEADER,
	infraAppPath,
	infraLoginReturnPath,
	selectInfraApp,
} from "@/lib/infra-routes";
import type { InfraStorageSnapshot } from "@/lib/infra-usage";
import {
	type InfraVideoDetail,
	type InfraVideoListItem,
	toInfraVideoDetail,
	toInfraVideoListItem,
} from "@/lib/infra-video-view";

export type DeveloperApiKey = Pick<
	typeof developerApiKeys.$inferSelect,
	"id" | "keyType" | "keyPrefix" | "createdAt" | "revokedAt"
>;

export type DeveloperApp = typeof developerApps.$inferSelect & {
	domains: (typeof developerAppDomains.$inferSelect)[];
	apiKeys: DeveloperApiKey[];
	creditAccount: typeof developerCreditAccounts.$inferSelect | null;
	videoCount: number;
};

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
		})),
		creditAccount: accountsByApp.get(app.id) ?? null,
		videoCount: countsByApp.get(app.id) ?? 0,
	}));
}

export async function getDeveloperAppVideos(
	appId: string,
	options?: { userId?: string; limit?: number; offset?: number },
): Promise<InfraVideoListItem[]> {
	const conditions = [
		eq(developerVideos.appId, appId),
		isNull(developerVideos.deletedAt),
	];

	const userMatch = options?.userId
		? exactUserIdMatch(developerVideos.externalUserId, options.userId)
		: undefined;
	if (userMatch) conditions.push(userMatch);

	const rows = await db()
		.select({
			id: developerVideos.id,
			name: developerVideos.name,
			externalUserId: developerVideos.externalUserId,
			duration: developerVideos.duration,
			width: developerVideos.width,
			createdAt: developerVideos.createdAt,
			status: developerVideos.status,
			legacy: sql<
				number | string
			>`(${developerVideos.playbackId} IS NULL AND ${developerVideos.processing} IS NULL)`,
		})
		.from(developerVideos)
		.where(and(...conditions))
		.orderBy(desc(developerVideos.createdAt))
		.limit(options?.limit ?? 50)
		.offset(options?.offset ?? 0);

	return rows.map((row) =>
		toInfraVideoListItem({ ...row, legacy: Number(row.legacy) === 1 }),
	);
}

async function findDeveloperAppVideo(appId: string, videoId: string) {
	const [row] = await db()
		.select({
			id: developerVideos.id,
			name: developerVideos.name,
			externalUserId: developerVideos.externalUserId,
			duration: developerVideos.duration,
			width: developerVideos.width,
			height: developerVideos.height,
			createdAt: developerVideos.createdAt,
			updatedAt: developerVideos.updatedAt,
			status: developerVideos.status,
			errorReason: developerVideos.errorReason,
			storedBytes: developerVideos.storedBytes,
			renditions: developerVideos.renditions,
			playbackId: developerVideos.playbackId,
			processing: developerVideos.processing,
		})
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);
	return row ?? null;
}

// Reading a video through the API restarts encoding that stalled or is due a
// retry. A customer who only uses the console has no other read, so opening
// the video's page does the same.
export const getDeveloperAppVideo = cache(
	async (appId: string, videoId: string): Promise<InfraVideoDetail | null> => {
		let row = await findDeveloperAppVideo(appId, videoId);
		if (!row) return null;
		if (
			developerVideoRedrive({ ...row, deletedAt: null }, Date.now()) &&
			(await redriveDeveloperVideoProcessing(videoId))
		) {
			row = (await findDeveloperAppVideo(appId, videoId)) ?? row;
		}
		return toInfraVideoDetail(
			{ ...row, legacy: row.playbackId === null && row.processing === null },
			developerVideoPlaybackUrls(row),
			row.playbackId ? developerVideoPageUrls(row.playbackId) : null,
		);
	},
);

const getInfraAppsForUser = cache((userId: (typeof userSelectProps)["id"]) =>
	getDeveloperApps({ id: userId }),
);

export type InfraAccess = "signed_out" | "outside_preview" | "allowed";

export async function getInfraAccess(): Promise<InfraAccess> {
	const user = await getCurrentUser();
	if (!user) return "signed_out";
	return canUseInfra(user.email) ? "allowed" : "outside_preview";
}

async function requireInfraUser(returnTo: string = INFRA_BASE_PATH) {
	const user = await getCurrentUser();
	if (!user) {
		const requested = (await headers()).get(INFRA_PATH_HEADER);
		const next = infraLoginReturnPath(requested, returnTo);
		redirect(`/login?next=${encodeURIComponent(next)}`);
	}
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

export async function getInfraApps(returnTo?: string) {
	const user = await requireInfraUser(returnTo);
	return getInfraAppsForUser(user.id);
}

export async function getSelectedInfraApp() {
	const [apps, cookieStore] = await Promise.all([getInfraApps(), cookies()]);
	return selectInfraApp(apps, cookieStore.get(INFRA_APP_COOKIE)?.value);
}

export async function requireInfraApp(appId: string) {
	const apps = await getInfraApps(infraAppPath(appId));
	const app = apps.find((a) => a.id === appId);
	if (!app) notFound();
	return { app, apps };
}

// A page title is only sent once the app is known to exist for this viewer.
// Anyone else gets the layouts' titles, so a missing app or an account outside
// the preview never sees a section name in the tab.
export const infraPageMetadata =
	(title: string) =>
	async ({
		params,
	}: {
		params: Promise<{ appId: string }>;
	}): Promise<Metadata> => {
		if ((await getInfraAccess()) === "signed_out") return {};
		const { appId } = await params;
		await requireInfraApp(appId);
		return { title: `${title} | Cap Infra` };
	};

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
