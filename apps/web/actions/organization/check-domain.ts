"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { checkDomainStatus } from "./domain-utils";

export async function checkOrganizationDomain(organizationId: string) {
	const user = await getCurrentUser();

	if (!user || !organizationId) {
		throw new Error("Unauthorized");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization || organization.ownerId !== user.id) {
		throw new Error("Only the owner can check domain status");
	}

	if (!organization.customDomain) {
		throw new Error("No custom domain set");
	}

	try {
		const status = await checkDomainStatus(organization.customDomain);

		if (status.verified && !organization.domainVerified) {
			await db()
				.update(organizations)
				.set({
					domainVerified: new Date(),
				})
				.where(eq(organizations.id, organizationId));
		} else if (!status.verified && organization.domainVerified) {
			await db()
				.update(organizations)
				.set({
					domainVerified: null,
				})
				.where(eq(organizations.id, organizationId));
		}

		return status;
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to check domain status");
	}
}
