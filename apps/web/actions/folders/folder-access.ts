import type { Organisation, Space, User } from "@cap/web-domain";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";
import { canManageSpace } from "@/lib/permissions/roles";

export async function canViewFolder(
	userId: User.UserId,
	folder: {
		organizationId: Organisation.OrganisationId;
		spaceId: Space.SpaceIdOrOrganisationId | null;
		createdById: User.UserId;
	},
) {
	if (folder.spaceId === null) return folder.createdById === userId;

	if (folder.spaceId === folder.organizationId) {
		return (
			(await getOrganizationAccess(userId, folder.organizationId)) !== null
		);
	}

	const access = await getSpaceAccess(userId, folder.spaceId);
	return Boolean(
		access &&
			access.organizationId === folder.organizationId &&
			(access.spaceRole || canManageSpace(access)),
	);
}
