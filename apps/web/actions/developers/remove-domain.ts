"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerAppDomains, developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeDeveloperDomain(appId: string, domainId: string) {
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

	await db()
		.delete(developerAppDomains)
		.where(
			and(
				eq(developerAppDomains.id, domainId),
				eq(developerAppDomains.appId, appId),
			),
		);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
