import "server-only";

import type { db } from "@cap/database";
import { organizationMembers } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

// Share-locks the checked membership rows so an organization removal, which
// locks the same rows for update before deleting space memberships, cannot
// commit until the caller's space member writes do.
export async function usersBelongToOrganization(
	tx: Transaction,
	organizationId: Organisation.OrganisationId,
	organizationOwnerId: User.UserId,
	userIds: User.UserId[],
) {
	const uniqueUserIds = Array.from(new Set(userIds));
	if (uniqueUserIds.length === 0) return true;

	const rows = await tx
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				inArray(organizationMembers.userId, uniqueUserIds),
			),
		)
		.for("share");
	const allowedUserIds = new Set([
		organizationOwnerId,
		...rows.map((row) => row.userId),
	]);

	return uniqueUserIds.every((id) => allowedUserIds.has(id));
}
