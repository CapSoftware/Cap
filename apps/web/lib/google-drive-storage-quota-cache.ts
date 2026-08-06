import { db } from "@cap/database";
import { storageIntegrations } from "@cap/database/schema";
import { Storage } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

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
					eq(storageIntegrations.provider, "googleDrive"),
				),
			);
	} catch (error) {
		console.error("Failed to invalidate Google Drive storage quota:", error);
	}
};
