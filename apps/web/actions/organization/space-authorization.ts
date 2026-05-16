"use server";

import { db } from "@cap/database";
import {
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
} from "@cap/database/schema";
import type { Organisation, Space, User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import {
	canManageSpace,
	getEffectiveOrganizationRole,
	getEffectiveSpaceRole,
	type OrganizationRole,
	type SpaceRole,
} from "@/lib/permissions/roles";

export type SpaceAccess = {
	spaceId: Space.SpaceIdOrOrganisationId;
	organizationId: Organisation.OrganisationId;
	organizationOwnerId: User.UserId;
	createdById: User.UserId;
	organizationRole: OrganizationRole | null;
	spaceRole: SpaceRole | null;
	canManage: boolean;
};

export async function getSpaceAccess(
	userId: User.UserId,
	spaceId: Space.SpaceIdOrOrganisationId,
): Promise<SpaceAccess | null> {
	const [space] = await db()
		.select({
			id: spaces.id,
			organizationId: spaces.organizationId,
			createdById: spaces.createdById,
			ownerId: organizations.ownerId,
			organizationMemberRole: organizationMembers.role,
			spaceMemberRole: spaceMembers.role,
		})
		.from(spaces)
		.innerJoin(organizations, eq(spaces.organizationId, organizations.id))
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, spaces.organizationId),
				eq(organizationMembers.userId, userId),
			),
		)
		.leftJoin(
			spaceMembers,
			and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, userId)),
		)
		.where(and(eq(spaces.id, spaceId), isNull(organizations.tombstoneAt)))
		.limit(1);

	if (!space) return null;

	const organizationRole = getEffectiveOrganizationRole({
		userId,
		ownerId: space.ownerId,
		memberRole: space.organizationMemberRole,
	});
	const spaceRole = getEffectiveSpaceRole({
		userId,
		createdById: space.createdById,
		memberRole: space.spaceMemberRole,
	});

	return {
		spaceId: space.id,
		organizationId: space.organizationId,
		organizationOwnerId: space.ownerId,
		createdById: space.createdById,
		organizationRole,
		spaceRole,
		canManage: canManageSpace({ organizationRole, spaceRole }),
	};
}

export async function requireSpaceManager(
	userId: User.UserId,
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	const access = await getSpaceAccess(userId, spaceId);
	if (!access) throw new Error("Space not found");
	if (!access.canManage) {
		throw new Error(
			"Only space admins, organization admins, and owners can manage this space",
		);
	}
	return access;
}
