"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	developerAppEnvironment,
	developerAppLogoUrl,
	developerAppName,
} from "@/lib/developer-app-limits";
import { canUseInfra } from "@/lib/infra-access";
import { actionFailure } from "@/lib/infra-action-result";

export async function updateDeveloperApp(data: {
	appId: string;
	name?: string;
	environment?: "development" | "production";
	logoUrl?: string | null;
}) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, data.appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!app) throw new Error("App not found");

	const updates: Partial<typeof developerApps.$inferInsert> = {};
	if (data.name !== undefined) {
		const named = developerAppName(data.name);
		if (!named.ok) return actionFailure(named.message);
		updates.name = named.name;
	}
	if (data.environment !== undefined) {
		const chosen = developerAppEnvironment(data.environment);
		if (!chosen.ok) return actionFailure(chosen.message);
		updates.environment = chosen.environment;
	}
	if (data.logoUrl !== undefined) {
		const logo = developerAppLogoUrl(data.logoUrl);
		if (!logo.ok) return actionFailure(logo.message);
		updates.logoUrl = logo.logoUrl;
	}

	if (Object.keys(updates).length > 0) {
		await db()
			.update(developerApps)
			.set(updates)
			.where(eq(developerApps.id, data.appId));
	}

	revalidatePath("/dashboard/infra", "layout");
	return { success: true as const };
}
