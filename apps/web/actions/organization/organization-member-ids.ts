import { db } from "@cap/database";
import { organizationMembers } from "@cap/database/schema";
import { type Organisation, User } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";

export async function filterUsersInOrganization(
	organizationId: Organisation.OrganisationId,
	organizationOwnerId: User.UserId,
	userIds: User.UserId[],
) {
	const uniqueUserIds = Array.from(new Set(userIds));
	if (uniqueUserIds.length === 0) return [];

	const rows = await db()
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				inArray(
					organizationMembers.userId,
					uniqueUserIds.map((id) => User.UserId.make(id)),
				),
			),
		);
	const allowedUserIds = new Set([
		organizationOwnerId,
		...rows.map((row) => row.userId),
	]);
	return uniqueUserIds.filter((id) => allowedUserIds.has(id));
}

export async function assertUsersBelongToOrganization(
	organizationId: Organisation.OrganisationId,
	organizationOwnerId: User.UserId,
	userIds: User.UserId[],
) {
	const uniqueUserIds = Array.from(new Set(userIds));
	const allowedUserIds = await filterUsersInOrganization(
		organizationId,
		organizationOwnerId,
		uniqueUserIds,
	);

	if (allowedUserIds.length !== uniqueUserIds.length) {
		throw new Error("All space members must belong to the organization");
	}
}
