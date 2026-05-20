import { db } from "@cap/database";
import { organizationMembers, organizations } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, or } from "drizzle-orm";
import {
	canManageOrganizationBilling,
	canManageOrganizationProSeats,
	canManageOrganizationSettings,
	canViewOrganizationSettings,
	getEffectiveOrganizationRole,
	type OrganizationRole,
} from "@/lib/permissions/roles";

export type OrganizationAccess = {
	id: Organisation.OrganisationId;
	ownerId: User.UserId;
	memberId: string | null;
	role: OrganizationRole;
};

export async function getOrganizationAccess(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
): Promise<OrganizationAccess | null> {
	const [organization] = await db()
		.select({
			id: organizations.id,
			ownerId: organizations.ownerId,
			memberId: organizationMembers.id,
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
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, userId),
					eq(organizationMembers.userId, userId),
				),
			),
		)
		.limit(1);

	if (!organization) return null;

	const role = getEffectiveOrganizationRole({
		userId,
		ownerId: organization.ownerId,
		memberRole: organization.memberRole,
	});

	if (!role) return null;

	return {
		id: organization.id,
		ownerId: organization.ownerId,
		memberId: organization.memberId,
		role,
	};
}

export async function requireOrganizationAccess(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) {
	const access = await getOrganizationAccess(userId, organizationId);
	if (!access) throw new Error("Forbidden");
	return access;
}

export async function requireOrganizationSettingsAccess(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) {
	const access = await requireOrganizationAccess(userId, organizationId);
	if (!canViewOrganizationSettings(access.role)) {
		throw new Error(
			"Organization settings are only available to admins and owners",
		);
	}
	return access;
}

export async function requireOrganizationSettingsManager(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) {
	const access = await requireOrganizationSettingsAccess(
		userId,
		organizationId,
	);
	if (!canManageOrganizationSettings(access.role)) {
		throw new Error("Only admins and owners can manage organization settings");
	}
	return access;
}

export async function requireOrganizationProSeatManager(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) {
	const access = await requireOrganizationSettingsAccess(
		userId,
		organizationId,
	);
	if (!canManageOrganizationProSeats(access.role)) {
		throw new Error("Only admins and owners can manage Pro seats");
	}
	return access;
}

export async function requireOrganizationOwner(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) {
	const access = await requireOrganizationAccess(userId, organizationId);
	if (!canManageOrganizationBilling(access.role)) {
		throw new Error("Only the owner can manage this organization setting");
	}
	return access;
}
