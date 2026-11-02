import "server-only";

import { db } from "@cap/database";
import { organizationMembers } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";

export async function usersBelongToOrganization(
	organizationId: Organisation.OrganisationId,
	organizationOwnerId: User.UserId,
	userIds: User.UserId[],
) {
	const uniqueUserIds = Array.from(new Set(userIds));
	if (uniqueUserIds.length === 0) return true;

	const rows = await db()
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				inArray(organizationMembers.userId, uniqueUserIds),
			),
		);
	const allowedUserIds = new Set([
		organizationOwnerId,
		...rows.map((row) => row.userId),
	]);

	return uniqueUserIds.every((id) => allowedUserIds.has(id));
}
