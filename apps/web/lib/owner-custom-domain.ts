import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/** The verified custom domain of the organisation the owner is working in. */
export async function ownerCustomDomain(
	activeOrganizationId: Organisation.OrganisationId | null | undefined,
) {
	if (!activeOrganizationId) return null;
	const [org] = await db()
		.select({
			customDomain: organizations.customDomain,
			domainVerified: organizations.domainVerified,
		})
		.from(organizations)
		.where(eq(organizations.id, activeOrganizationId))
		.limit(1);
	return org?.customDomain && org.domainVerified !== null
		? org.customDomain
		: null;
}
