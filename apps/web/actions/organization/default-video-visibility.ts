"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

export type OrganizationVideoVisibility = "private" | "members" | null;

const isOrganizationVideoVisibility = (
	value: unknown,
): value is OrganizationVideoVisibility =>
	value === null || value === "private" || value === "members";

export async function updateDefaultVideoVisibility(
	visibility: OrganizationVideoVisibility,
) {
	if (!isOrganizationVideoVisibility(visibility)) {
		throw new Error("Invalid sharing default");
	}

	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	const organizationId = user.activeOrganizationId;
	await requireOrganizationSettingsManager(user.id, organizationId);

	await db()
		.update(organizations)
		.set({ defaultVideoVisibility: visibility })
		.where(eq(organizations.id, organizationId));

	revalidatePath("/dashboard/settings/organization/preferences");
	revalidatePath("/dashboard", "layout");
	return { success: true };
}
