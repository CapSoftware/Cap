import { db } from "@cap/database";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export type UserOrganizationSelection = {
	id: Organisation.OrganisationId;
	name: string;
	createdAt: Date;
};

export function mergeUserOrganizationSelections(
	...rowSets: UserOrganizationSelection[][]
) {
	const organizationsById = new Map<string, UserOrganizationSelection>();

	for (const rows of rowSets) {
		for (const row of rows) {
			organizationsById.set(row.id, row);
		}
	}

	return Array.from(organizationsById.values())
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.map(({ createdAt, ...organization }) => organization);
}

export function selectDesktopRecordingOrganization(
	available: ReadonlyArray<{ id: Organisation.OrganisationId }>,
	requested?: Organisation.OrganisationId,
	defaultId?: Organisation.OrganisationId | null,
): Organisation.OrganisationId | undefined {
	const ids = new Set(available.map((organization) => organization.id));
	if (requested && ids.has(requested)) return requested;
	if (defaultId && ids.has(defaultId)) return defaultId;
	return available[0]?.id;
}

export async function getDesktopRecordingOrganization(
	userId: User.UserId,
	requested?: Organisation.OrganisationId,
): Promise<Organisation.OrganisationId | undefined> {
	const [[user], owned, joined] = await Promise.all([
		db()
			.select({ defaultOrgId: users.defaultOrgId })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1),
		db()
			.select({
				id: organizations.id,
				name: organizations.name,
				createdAt: organizations.createdAt,
			})
			.from(organizations)
			.where(
				and(
					eq(organizations.ownerId, userId),
					isNull(organizations.tombstoneAt),
				),
			),
		db()
			.select({
				id: organizations.id,
				name: organizations.name,
				createdAt: organizations.createdAt,
			})
			.from(organizationMembers)
			.innerJoin(
				organizations,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.where(
				and(
					eq(organizationMembers.userId, userId),
					isNull(organizations.tombstoneAt),
				),
			),
	]);
	const available = mergeUserOrganizationSelections(owned, joined);
	return selectDesktopRecordingOrganization(
		available,
		requested,
		user?.defaultOrgId,
	);
}
