"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { developerAppDomains, developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { canUseInfra } from "@/lib/infra-access";
import { actionFailure } from "@/lib/infra-action-result";
import { normalizeAllowedOrigin } from "@/lib/infra-domain";

export async function addDeveloperDomain(appId: string, domain: string) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");

	const allowed = normalizeAllowedOrigin(domain);
	if (!allowed.ok) return actionFailure(allowed.message);
	const { origin } = allowed;

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

	const [existing] = await db()
		.select({ id: developerAppDomains.id })
		.from(developerAppDomains)
		.where(
			and(
				eq(developerAppDomains.appId, appId),
				eq(developerAppDomains.domain, origin),
			),
		)
		.limit(1);
	if (existing) return actionFailure(`${origin} is already allowed.`);

	await db().insert(developerAppDomains).values({
		id: nanoId(),
		appId,
		domain: origin,
	});

	revalidatePath("/dashboard/infra", "layout");
	return { success: true as const, domain: origin };
}
