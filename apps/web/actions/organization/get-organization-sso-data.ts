"use server";

import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { Organisation } from "@cap/web-domain";

export async function getOrganizationSSOData(
	organizationId: Organisation.OrganisationId,
) {
	if (!organizationId) {
		throw new Error("Organization ID is required");
	}

	const [organization] = await db()
		.select({
			workosOrganizationId: organizations.workosOrganizationId,
			workosConnectionId: organizations.workosConnectionId,
			name: organizations.name,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (
		!organization ||
		!organization.workosOrganizationId ||
		!organization.workosConnectionId
	) {
		throw new Error("Organization not found or SSO not configured");
	}

	return {
		organizationId: organization.workosOrganizationId,
		connectionId: organization.workosConnectionId,
		name: organization.name,
	};
}
