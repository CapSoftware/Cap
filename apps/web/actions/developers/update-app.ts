"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateDeveloperApp(data: {
	appId: string;
	name?: string;
	environment?: "development" | "production";
	logoUrl?: string | null;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

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
		const trimmed = data.name.trim();
		if (!trimmed) throw new Error("App name cannot be empty");
		updates.name = trimmed;
	}
	if (data.environment !== undefined) updates.environment = data.environment;
	if (data.logoUrl !== undefined) updates.logoUrl = data.logoUrl;

	if (Object.keys(updates).length > 0) {
		await db()
			.update(developerApps)
			.set(updates)
			.where(eq(developerApps.id, data.appId));
	}

	revalidatePath("/dashboard/developers");
	return { success: true };
}
