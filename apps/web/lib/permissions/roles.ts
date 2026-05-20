export const organizationRoles = ["owner", "admin", "member"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export const assignableOrganizationRoles = ["admin", "member"] as const;
export type AssignableOrganizationRole =
	(typeof assignableOrganizationRoles)[number];

export const spaceRoles = ["admin", "member"] as const;
export type SpaceRole = (typeof spaceRoles)[number];

const organizationRoleRank: Record<OrganizationRole, number> = {
	owner: 3,
	admin: 2,
	member: 1,
};

const spaceRoleRank: Record<SpaceRole, number> = {
	admin: 2,
	member: 1,
};

function includesValue<T extends readonly string[]>(
	values: T,
	value: string,
): value is T[number] {
	return values.includes(value);
}

function getOrganizationRoleRank(role: OrganizationRole | null | undefined) {
	return role ? organizationRoleRank[role] : 0;
}

function organizationRoleOutranks(
	actorRole: OrganizationRole | null | undefined,
	targetRole: OrganizationRole | null | undefined,
) {
	return (
		getOrganizationRoleRank(actorRole) > getOrganizationRoleRank(targetRole)
	);
}

export function normalizeOrganizationRole(
	role: string | null | undefined,
): OrganizationRole | null {
	if (!role) return null;
	const normalized = role.toLowerCase();
	return includesValue(organizationRoles, normalized) ? normalized : null;
}

export function normalizeAssignableOrganizationRole(
	role: string | null | undefined,
): AssignableOrganizationRole | null {
	if (!role) return null;
	const normalized = role.toLowerCase();
	return includesValue(assignableOrganizationRoles, normalized)
		? normalized
		: null;
}

export function getEffectiveOrganizationRole({
	userId,
	ownerId,
	memberRole,
}: {
	userId: string | null | undefined;
	ownerId: string | null | undefined;
	memberRole: string | null | undefined;
}): OrganizationRole | null {
	if (userId && ownerId && userId === ownerId) return "owner";
	const role = normalizeOrganizationRole(memberRole);
	return role === "owner" ? "member" : role;
}

export function normalizeSpaceRole(
	role: string | null | undefined,
): SpaceRole | null {
	if (!role) return null;
	const normalized = role.toLowerCase();
	return includesValue(spaceRoles, normalized) ? normalized : null;
}

export function getEffectiveSpaceRole({
	userId,
	createdById,
	memberRole,
}: {
	userId: string | null | undefined;
	createdById: string | null | undefined;
	memberRole: string | null | undefined;
}): SpaceRole | null {
	if (userId && createdById && userId === createdById) return "admin";
	return normalizeSpaceRole(memberRole);
}

export function canViewOrganizationSettings(
	role: OrganizationRole | null | undefined,
) {
	return role === "owner" || role === "admin";
}

export function canManageOrganizationMembers(
	role: OrganizationRole | null | undefined,
) {
	return role === "owner" || role === "admin";
}

export function canManageOrganizationBilling(
	role: OrganizationRole | null | undefined,
) {
	return role === "owner";
}

export function canManageOrganizationProSeats(
	role: OrganizationRole | null | undefined,
) {
	return role === "owner" || role === "admin";
}

export function canManageOrganizationSettings(
	role: OrganizationRole | null | undefined,
) {
	return role === "owner" || role === "admin";
}

export function isOrganizationOwnerTarget({
	targetUserId,
	ownerId,
	targetRole,
}: {
	targetUserId: string | null | undefined;
	ownerId: string | null | undefined;
	targetRole: OrganizationRole | null | undefined;
}) {
	return targetRole === "owner" || (!!targetUserId && targetUserId === ownerId);
}

export function canChangeOrganizationMemberRole({
	actorRole,
	actorUserId,
	targetUserId,
	ownerId,
	targetRole,
	nextRole,
}: {
	actorRole: OrganizationRole | null | undefined;
	actorUserId: string | null | undefined;
	targetUserId: string | null | undefined;
	ownerId: string | null | undefined;
	targetRole: OrganizationRole | null | undefined;
	nextRole: AssignableOrganizationRole | null | undefined;
}) {
	if (!canManageOrganizationMembers(actorRole)) return false;
	if (!nextRole) return false;
	if (isOrganizationOwnerTarget({ targetUserId, ownerId, targetRole })) {
		return false;
	}
	if (actorUserId && targetUserId && actorUserId === targetUserId) return false;
	if (!organizationRoleOutranks(actorRole, targetRole)) return false;
	return true;
}

export function canRemoveOrganizationMember({
	actorRole,
	actorUserId,
	targetUserId,
	ownerId,
	targetRole,
}: {
	actorRole: OrganizationRole | null | undefined;
	actorUserId: string | null | undefined;
	targetUserId: string | null | undefined;
	ownerId: string | null | undefined;
	targetRole: OrganizationRole | null | undefined;
}) {
	if (!canManageOrganizationMembers(actorRole)) return false;
	if (isOrganizationOwnerTarget({ targetUserId, ownerId, targetRole })) {
		return false;
	}
	if (actorUserId && targetUserId && actorUserId === targetUserId) return false;
	if (!organizationRoleOutranks(actorRole, targetRole)) return false;
	return true;
}

export function canManageSpace({
	organizationRole,
	spaceRole,
}: {
	organizationRole: OrganizationRole | null | undefined;
	spaceRole: SpaceRole | null | undefined;
}) {
	return (
		organizationRole === "owner" ||
		organizationRole === "admin" ||
		spaceRole === "admin"
	);
}

export function canChangeSpaceMemberRole({
	canManage,
	targetUserId,
	createdById,
	nextRole,
}: {
	canManage: boolean;
	targetUserId: string | null | undefined;
	createdById: string | null | undefined;
	nextRole: SpaceRole | null | undefined;
}) {
	if (!canManage) return false;
	if (!nextRole) return false;
	if (targetUserId && createdById && targetUserId === createdById) return false;
	return true;
}

export function canRemoveSpaceMember({
	canManage,
	targetUserId,
	createdById,
}: {
	canManage: boolean;
	targetUserId: string | null | undefined;
	createdById: string | null | undefined;
}) {
	if (!canManage) return false;
	if (targetUserId && createdById && targetUserId === createdById) return false;
	return true;
}

export function organizationRoleLabel(role: OrganizationRole) {
	return role[0]?.toUpperCase() + role.slice(1);
}

export function spaceRoleLabel(role: SpaceRole) {
	return role[0]?.toUpperCase() + role.slice(1);
}

export function compareOrganizationRoles(
	a: string | null | undefined,
	b: string | null | undefined,
) {
	const roleA = normalizeOrganizationRole(a);
	const roleB = normalizeOrganizationRole(b);
	return (
		(organizationRoleRank[roleB ?? "member"] ?? 0) -
		(organizationRoleRank[roleA ?? "member"] ?? 0)
	);
}

export function compareSpaceRoles(
	a: string | null | undefined,
	b: string | null | undefined,
) {
	const roleA = normalizeSpaceRole(a);
	const roleB = normalizeSpaceRole(b);
	return (
		(spaceRoleRank[roleB ?? "member"] ?? 0) -
		(spaceRoleRank[roleA ?? "member"] ?? 0)
	);
}
