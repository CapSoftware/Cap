"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

export async function updateDefaultVideoVisibility(privateByDefault: boolean) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	const organizationId = user.activeOrganizationId;
	await requireOrganizationSettingsManager(user.id, organizationId);

	await db()
		.update(organizations)
		.set({ defaultVideoVisibility: privateByDefault ? "private" : null })
		.where(eq(organizations.id, organizationId));

	revalidatePath("/dashboard/settings/organization/preferences");
	revalidatePath("/dashboard/caps");
	return { success: true };
}

export async function updateOrganizationVideoSharing(
	organizationId: Organisation.OrganisationId,
	restricted: boolean,
) {
	if (
		typeof restricted !== "boolean" ||
		typeof organizationId !== "string" ||
		!organizationId
	)
		throw new Error("Invalid sharing setting");
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	await requireOrganizationSettingsManager(user.id, organizationId);

	await db()
		.update(organizations)
		.set({ videoSharingRestrictedToOrg: restricted })
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		);

	revalidatePath("/dashboard", "layout");
	revalidatePath("/s/[videoId]", "page");
	revalidatePath("/embed/[videoId]", "page");
	return { success: true };
}
