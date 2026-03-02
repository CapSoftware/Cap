"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApiKeys, developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function deleteDeveloperApp(appId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

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

	await db().transaction(async (tx) => {
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
	});

	revalidatePath("/dashboard/developers");
	return { success: true };
}
