"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

export async function updateShareNewVideosWithOrganization(
	shareNewVideosWithOrganization: boolean,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (typeof shareNewVideosWithOrganization !== "boolean")
		throw new Error("Invalid sharing setting");

	await requireOrganizationSettingsManager(user.id, organizationId);

	await db()
		.update(organizations)
		.set({
			settings: sql`JSON_MERGE_PATCH(COALESCE(${organizations.settings}, JSON_OBJECT()), CAST(${JSON.stringify({ shareNewVideosWithOrganization })} AS JSON))`,
		})
		.where(eq(organizations.id, organizationId));

	revalidatePath("/dashboard/settings/organization/preferences");
	return { success: true };
}
