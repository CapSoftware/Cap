import "server-only";

import { db } from "@cap/database";
import { organizationMembers, organizations } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, or } from "drizzle-orm";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
	type OrganizationRole,
} from "@/lib/permissions/roles";

export type UserOrganization = {
	id: Organisation.OrganisationId;
	name: string;
	role: OrganizationRole;
	adminsOnly: boolean;
};

export async function userOrganizations(
	userId: User.UserId,
): Promise<UserOrganization[]> {
	const rows = await db()
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
			settings: organizations.settings,
			memberRole: organizationMembers.role,
		})
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
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, userId),
					eq(organizationMembers.userId, userId),
				),
			),
		);

	const byId = new Map<string, UserOrganization>();
	for (const row of rows) {
		const role = getEffectiveOrganizationRole({
			userId,
			ownerId: row.ownerId,
			memberRole: row.memberRole,
		});
		if (!role) continue;
		const existing = byId.get(row.id);
		if (existing && rank(existing.role) >= rank(role)) continue;
		byId.set(row.id, {
			id: row.id,
			name: row.name,
			role,
			adminsOnly: row.settings?.appStoreAdminsOnly === true,
		});
	}
	return [...byId.values()];
}

const rank = (role: OrganizationRole) =>
	role === "owner" ? 3 : role === "admin" ? 2 : 1;

export const canManageOrganizationApps = (
	organization: UserOrganization | undefined,
) => !!organization && canManageOrganizationSettings(organization.role);

export const memberMayInstallConnections = (
	organization: UserOrganization | undefined,
) =>
	!organization ||
	!organization.adminsOnly ||
	canManageOrganizationSettings(organization.role);
