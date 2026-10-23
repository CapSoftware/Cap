"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
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
