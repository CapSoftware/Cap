import { db } from "@cap/database";
import {
	folders,
	organizationMembers,
	organizations,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export type ShareDashboardDestination = {
	kind: "caps" | "folder" | "space" | "organization";
	href: string;
	label: string;
	switchOrganizationId: string | null;
};

export type ShareDashboardAccess = {
	isOwner: boolean;
	activeOrganizationId: string | null;
	videoOrganizationId: string;
	ownerIsVideoOrganizationMember: boolean;
	ownerFolder: { id: string; name: string } | null;
	memberSpaces: { id: string; name: string; organizationId: string }[];
	memberOrganizations: { id: string; name: string }[];
};

const byActiveOrganizationFirst =
	(activeOrganizationId: string | null) =>
	<T>(items: T[], organizationOf: (item: T) => string): T[] =>
		activeOrganizationId === null
			? items
			: [...items].sort(
					(a, b) =>
						Number(organizationOf(b) === activeOrganizationId) -
						Number(organizationOf(a) === activeOrganizationId),
				);

export function pickShareDashboardDestination(
	access: ShareDashboardAccess,
): ShareDashboardDestination | null {
	if (access.isOwner) {
		// My Caps lists only the active organization's Caps, and the folder page
		// 404s without an active organization, so the owner's destinations open
		// in the Cap's own organization. Space pages load under any of them.
		const switchOrganizationId =
			access.ownerIsVideoOrganizationMember &&
			access.videoOrganizationId !== access.activeOrganizationId
				? access.videoOrganizationId
				: null;
		if (access.ownerFolder) {
			return {
				kind: "folder",
				href: `/dashboard/folder/${access.ownerFolder.id}`,
				label: access.ownerFolder.name,
				switchOrganizationId,
			};
		}
		return {
			kind: "caps",
			href: "/dashboard/caps",
			label: "My Caps",
			switchOrganizationId,
		};
	}

	const activeFirst = byActiveOrganizationFirst(access.activeOrganizationId);
	const [space] = activeFirst(
		access.memberSpaces,
		(space) => space.organizationId,
	);
	const [organization] = activeFirst(
		access.memberOrganizations,
		(organization) => organization.id,
	);

	const spaceInActiveOrg =
		space && space.organizationId === access.activeOrganizationId;
	const organizationIsActive =
		organization && organization.id === access.activeOrganizationId;

	if (space && (spaceInActiveOrg || !organizationIsActive)) {
		return {
			kind: "space",
			href: `/dashboard/spaces/${space.id}`,
			label: space.name,
			switchOrganizationId: null,
		};
	}

	if (organization) {
		return {
			kind: "organization",
			href: `/dashboard/spaces/${organization.id}`,
			label: organization.name,
			switchOrganizationId: null,
		};
	}

	return null;
}

export async function getShareDashboardDestination({
	viewer,
	videoId,
	ownerId,
	videoOrganizationId,
}: {
	viewer: { id: User.UserId; activeOrganizationId: string | null } | null;
	videoId: Video.VideoId;
	ownerId: User.UserId;
	videoOrganizationId: Organisation.OrganisationId;
}): Promise<ShareDashboardDestination | null> {
	if (!viewer) return null;

	const isOwner = viewer.id === ownerId;

	const [
		ownerFolderRows,
		ownerMembershipRows,
		memberSpaces,
		memberOrganizations,
	] = await Promise.all([
		isOwner
			? db()
					.select({ id: folders.id, name: folders.name })
					.from(videos)
					.innerJoin(folders, eq(folders.id, videos.folderId))
					.where(and(eq(videos.id, videoId), isNull(folders.spaceId)))
					.limit(1)
			: Promise.resolve([]),
		isOwner && videoOrganizationId !== viewer.activeOrganizationId
			? db()
					.select({ id: organizationMembers.id })
					.from(organizationMembers)
					.where(
						and(
							eq(organizationMembers.userId, viewer.id),
							eq(organizationMembers.organizationId, videoOrganizationId),
						),
					)
					.limit(1)
			: Promise.resolve([]),
		isOwner
			? Promise.resolve([])
			: db()
					.select({
						id: spaces.id,
						name: spaces.name,
						organizationId: spaces.organizationId,
					})
					.from(spaceVideos)
					.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
					.innerJoin(
						spaceMembers,
						and(
							eq(spaceMembers.spaceId, spaces.id),
							eq(spaceMembers.userId, viewer.id),
						),
					)
					.where(eq(spaceVideos.videoId, videoId)),
		isOwner
			? Promise.resolve([])
			: db()
					.select({ id: organizations.id, name: organizations.name })
					.from(sharedVideos)
					.innerJoin(
						organizations,
						eq(sharedVideos.organizationId, organizations.id),
					)
					.innerJoin(
						organizationMembers,
						and(
							eq(organizationMembers.organizationId, organizations.id),
							eq(organizationMembers.userId, viewer.id),
						),
					)
					.where(
						and(
							eq(sharedVideos.videoId, videoId),
							isNull(organizations.tombstoneAt),
						),
					),
	]);

	return pickShareDashboardDestination({
		isOwner,
		activeOrganizationId: viewer.activeOrganizationId,
		videoOrganizationId,
		ownerIsVideoOrganizationMember: ownerMembershipRows.length > 0,
		ownerFolder: ownerFolderRows[0] ?? null,
		memberSpaces,
		memberOrganizations,
	});
}
