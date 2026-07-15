"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function deleteDeveloperVideo(appId: string, videoId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("未授权");

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

	if (!app) throw new Error("未找到应用");

	await db()
		.update(developerVideos)
		.set({ deletedAt: new Date() })
		.where(
			and(eq(developerVideos.id, videoId), eq(developerVideos.appId, appId)),
		);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
