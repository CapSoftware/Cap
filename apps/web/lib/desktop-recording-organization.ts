import { db } from "@cap/database";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

type UserOrganizationSelection = {
	id: Organisation.OrganisationId;
	name: string;
	createdAt: Date;
};

export function mergeUserOrganizationSelections(
	...rowSets: UserOrganizationSelection[][]
) {
	const byId = new Map<string, UserOrganizationSelection>();
	for (const rows of rowSets) {
		for (const row of rows) byId.set(row.id, row);
	}
	return Array.from(byId.values())
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.map(({ createdAt, ...organization }) => organization);
}

export function selectDesktopRecordingOrganization(
	available: Array<{ id: Organisation.OrganisationId }>,
	requested?: Organisation.OrganisationId,
	defaultId?: Organisation.OrganisationId | null,
) {
	return (
		[requested, defaultId].find(
			(id): id is Organisation.OrganisationId =>
				!!id && available.some((organization) => organization.id === id),
		) ?? available[0]?.id
	);
}

export async function getDesktopRecordingOrganization(
	userId: User.UserId,
	requested?: Organisation.OrganisationId,
) {
	const [[user], owned, member] = await Promise.all([
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
	return selectDesktopRecordingOrganization(
		mergeUserOrganizationSelections(owned, member),
		requested,
		user?.defaultOrgId,
	);
}
