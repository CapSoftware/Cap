import { db } from "@cap/database";
import { organizationMembers, organizations } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, or } from "drizzle-orm";

export async function requireOrganizationAccess(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) {
	const [organization] = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, userId),
			),
		)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, userId),
					eq(organizationMembers.userId, userId),
				),
			),
		)
		.limit(1);

	if (!organization) throw new Error("Forbidden");
}
