"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { hashPassword } from "@cap/database/crypto";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

function revalidateOrganizationSettingsPaths() {
	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard/settings/organization/preferences");
}

export async function setOrganizationDefaultVideoPassword(password: string) {
	try {
		const user = await getCurrentUser();

		if (!user?.activeOrganizationId) throw new Error("Unauthorized");

		if (typeof password !== "string" || password.trim().length === 0)
			throw new Error("Password is required");

		if (password.length > 255) throw new Error("Password is too long");

		await requireOrganizationSettingsManager(
			user.id,
			user.activeOrganizationId,
		);

		const hashed = await hashPassword(password);
		await db()
			.update(organizations)
			.set({ defaultVideoPassword: hashed })
			.where(eq(organizations.id, user.activeOrganizationId));

		revalidateOrganizationSettingsPaths();

		return { success: true, value: "Default password updated successfully" };
	} catch (error) {
		console.error("Error setting organization default video password:", error);
		return { success: false, error: "Failed to update default password" };
	}
}

export async function removeOrganizationDefaultVideoPassword() {
	try {
		const user = await getCurrentUser();

		if (!user?.activeOrganizationId) throw new Error("Unauthorized");

		await requireOrganizationSettingsManager(
			user.id,
			user.activeOrganizationId,
		);

		await db()
			.update(organizations)
			.set({ defaultVideoPassword: null })
			.where(eq(organizations.id, user.activeOrganizationId));

		revalidateOrganizationSettingsPaths();

		return { success: true, value: "Default password removed successfully" };
	} catch (error) {
		console.error("Error removing organization default video password:", error);
		return { success: false, error: "Failed to remove default password" };
	}
}
