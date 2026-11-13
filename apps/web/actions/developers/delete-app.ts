"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	developerApiKeys,
	developerApps,
	developerVideos,
} from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { canUseInfra } from "@/lib/infra-access";
import { settleFirstMonthsForDeletedApp } from "@/lib/infra-storage-minimum";

export async function deleteDeveloperApp(appId: string) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!app) throw new Error("App not found");

	const deletedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	await db().transaction(async (tx) => {
		await tx
			.update(developerApiKeys)
			.set({ revokedAt: deletedAt })
			.where(
				and(
					eq(developerApiKeys.appId, appId),
					isNull(developerApiKeys.revokedAt),
				),
			);

		await tx
			.update(developerApps)
			.set({ deletedAt })
			.where(eq(developerApps.id, appId));

		await tx
			.update(developerVideos)
			.set({ deletedAt })
			.where(
				and(
					eq(developerVideos.appId, appId),
					isNull(developerVideos.deletedAt),
				),
			);
	});
	await settleFirstMonthsForDeletedApp(appId, deletedAt);

	revalidatePath("/dashboard/infra", "layout");
	return { success: true };
}
