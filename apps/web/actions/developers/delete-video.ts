"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cancelDeveloperVideoEncodes } from "@/lib/developer-video-cancel";
import { canUseInfra } from "@/lib/infra-access";
import { settleFirstMonthAtDelete } from "@/lib/infra-storage-minimum";

export async function deleteDeveloperVideo(appId: string, videoId: string) {
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

	const [deleted] = await db()
		.update(developerVideos)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
			),
		);
	if (deleted.affectedRows > 0) await settleFirstMonthAtDelete(videoId);
	await cancelDeveloperVideoEncodes({ appId, videoId });

	revalidatePath("/dashboard/infra", "layout");
	return { success: true };
}
