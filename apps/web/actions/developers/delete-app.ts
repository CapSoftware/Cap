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
import { settleFirstMonthsForDeletedVideos } from "@/lib/infra-storage-minimum";

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

	const encodingVideoIds = await db().transaction(async (tx) => {
		const encoding = await tx
			.select({ id: developerVideos.id })
			.from(developerVideos)
			.where(
				and(
					eq(developerVideos.appId, appId),
					isNull(developerVideos.deletedAt),
					eq(developerVideos.status, "processing"),
				),
			);

		await tx
			.update(developerApiKeys)
			.set({ revokedAt: new Date() })
			.where(
				and(
					eq(developerApiKeys.appId, appId),
					isNull(developerApiKeys.revokedAt),
				),
			);

		await tx
			.update(developerApps)
			.set({ deletedAt: new Date() })
			.where(eq(developerApps.id, appId));

		await tx
			.update(developerVideos)
			.set({ deletedAt: new Date() })
			.where(
				and(
					eq(developerVideos.appId, appId),
					isNull(developerVideos.deletedAt),
				),
			);
		return encoding.map((video) => video.id);
	});
	await settleFirstMonthsForDeletedVideos(encodingVideoIds);

	revalidatePath("/dashboard/infra", "layout");
	return { success: true };
}
