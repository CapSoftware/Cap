"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";
import { removeDomain } from "./domain-utils";

export async function removeOrganizationDomain(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization) throw new Error("Organization not found");

	await requireOrganizationSettingsManager(user.id, organizationId);

	try {
		if (organization.customDomain) {
			await removeDomain(organization.customDomain);
		}

		await db()
			.update(organizations)
			.set({
				customDomain: null,
				domainVerified: null,
			})
			.where(eq(organizations.id, organizationId));

		revalidatePath("/dashboard/settings/organization");

		return { success: true };
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to remove domain");
	}
}
