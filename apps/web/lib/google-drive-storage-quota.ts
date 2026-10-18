import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import { storageIntegrations } from "@cap/database/schema";
import {
	type GoogleDriveIntegrationConfig,
	type GoogleDriveStorageQuota,
	type GoogleDriveStorageQuotaCache,
	getGoogleDriveStorageQuota,
} from "@cap/web-backend";
import { Storage } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { runPromise } from "@/lib/server";

const googleDriveProvider = "googleDrive";
const storageQuotaCacheTtlMs = 30 * 60 * 1000;
const storageQuotaRefreshFloorMs = 60 * 1000;

type StorageIntegration = typeof storageIntegrations.$inferSelect;

export type GoogleDriveStorageQuotaSnapshot = {
	limit: string | null;
	usage: string | null;
	usageInDrive: string | null;
	usageInDriveTrash: string | null;
	remaining: string | null;
	fetchedAt: string;
	stale: boolean;
};

const parseConfig = async (encryptedConfig: string) =>
	JSON.parse(await decrypt(encryptedConfig)) as GoogleDriveIntegrationConfig;

const nullableString = (value?: string | null) => value ?? null;

const remainingBytes = (
	limit?: string | null,
	usage?: string | null,
): string | null => {
	if (!limit || !usage) return null;

	try {
		const remaining = BigInt(limit) - BigInt(usage);
		return (remaining > 0n ? remaining : 0n).toString();
	} catch {
		return null;
	}
};

const toCache = (
	quota: GoogleDriveStorageQuota,
): GoogleDriveStorageQuotaCache => ({
	limit: nullableString(quota.limit),
	usage: nullableString(quota.usage),
	usageInDrive: nullableString(quota.usageInDrive),
	usageInDriveTrash: nullableString(quota.usageInDriveTrash),
	fetchedAt: new Date().toISOString(),
});

const toSnapshot = (
	quota: GoogleDriveStorageQuotaCache,
	stale: boolean,
): GoogleDriveStorageQuotaSnapshot => {
	const limit = nullableString(quota.limit);
	const usage = nullableString(quota.usage);

	return {
		limit,
		usage,
		usageInDrive: nullableString(quota.usageInDrive),
		usageInDriveTrash: nullableString(quota.usageInDriveTrash),
		remaining: remainingBytes(limit, usage),
		fetchedAt: quota.fetchedAt,
		stale,
	};
};

const isFresh = (quota: GoogleDriveStorageQuotaCache, ttlMs: number) => {
	const fetchedAt = Date.parse(quota.fetchedAt);
	return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlMs;
};

const saveQuotaCache = async (
	integrationId: Storage.StorageIntegrationId,
	encryptedConfig: string,
	storageQuotaCache: GoogleDriveStorageQuotaCache,
) => {
	await db()
		.update(storageIntegrations)
		.set({ googleDriveStorageQuotaCache: storageQuotaCache })
		.where(
			and(
				eq(storageIntegrations.id, integrationId),
				eq(storageIntegrations.provider, googleDriveProvider),
				eq(storageIntegrations.status, "active"),
				eq(storageIntegrations.encryptedConfig, encryptedConfig),
			),
		);
};

export const getCachedGoogleDriveStorageQuota = async (
	integration: StorageIntegration,
	options?: { forceRefresh?: boolean },
): Promise<GoogleDriveStorageQuotaSnapshot | null> => {
	if (
		integration.provider !== googleDriveProvider ||
		integration.status !== "active"
	) {
		return null;
	}

	const config = await parseConfig(integration.encryptedConfig);
	const cached = integration.googleDriveStorageQuotaCache;
	const ttlMs = options?.forceRefresh
		? storageQuotaRefreshFloorMs
		: storageQuotaCacheTtlMs;

	if (cached && isFresh(cached, ttlMs)) return toSnapshot(cached, false);

	try {
		const quota = await getGoogleDriveStorageQuota(config).pipe(runPromise);
		const storageQuotaCache = toCache(quota);
		await saveQuotaCache(
			integration.id,
			integration.encryptedConfig,
			storageQuotaCache,
		);
		return toSnapshot(storageQuotaCache, false);
	} catch (error) {
		console.error("Failed to refresh Google Drive storage quota:", error);
		return cached ? toSnapshot(cached, true) : null;
	}
};

export const invalidateGoogleDriveStorageQuotaCache = async (
	integrationId: string | null | undefined,
) => {
	if (!integrationId) return;
	const storageIntegrationId = Storage.StorageIntegrationId.make(integrationId);

	try {
		await db()
			.update(storageIntegrations)
			.set({ googleDriveStorageQuotaCache: null })
			.where(
				and(
					eq(storageIntegrations.id, storageIntegrationId),
					eq(storageIntegrations.provider, googleDriveProvider),
				),
			);
	} catch (error) {
		console.error("Failed to invalidate Google Drive storage quota:", error);
	}
};
