"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { developerAppDomains, developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addDeveloperDomain(appId: string, domain: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("未授权");

	const trimmed = domain.trim().toLowerCase();
	if (!trimmed) throw new Error("请输入域名");

	const urlPattern = /^https?:\/\/[a-z0-9.-]+(:[0-9]+)?$/;
	if (!urlPattern.test(trimmed)) {
		throw new Error("域名必须是有效的来源地址（例如 https://myapp.com）");
	}

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

	await db().insert(developerAppDomains).values({
		id: nanoId(),
		appId,
		domain: trimmed,
	});

	revalidatePath("/dashboard/developers");
	return { success: true };
}
