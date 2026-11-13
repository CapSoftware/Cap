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
import { cancelDeveloperVideoEncodes } from "@/lib/developer-video-cancel";
import { canUseInfra } from "@/lib/infra-access";

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

	const now = new Date();
	await db().transaction(async (tx) => {
		await tx
			.update(developerApiKeys)
			.set({ revokedAt: now })
			.where(
				and(
					eq(developerApiKeys.appId, appId),
					isNull(developerApiKeys.revokedAt),
				),
			);

		await tx
			.update(developerApps)
			.set({ deletedAt: now })
			.where(eq(developerApps.id, appId));

		await tx
			.update(developerVideos)
			.set({ deletedAt: now })
			.where(
				and(
					eq(developerVideos.appId, appId),
					isNull(developerVideos.deletedAt),
				),
			);
	});
	await cancelDeveloperVideoEncodes({ appId, deletedAt: now });

	revalidatePath("/dashboard/infra", "layout");
	return { success: true };
}
