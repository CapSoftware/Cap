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
import type { User, Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export type ShareDashboardDestination = {
	kind: "caps" | "folder" | "space" | "organization";
	href: string;
	label: string;
};

export type ShareDashboardAccess = {
	isOwner: boolean;
	activeOrganizationId: string | null;
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
		if (access.ownerFolder) {
			return {
				kind: "folder",
				href: `/dashboard/folder/${access.ownerFolder.id}`,
				label: access.ownerFolder.name,
			};
		}
		return { kind: "caps", href: "/dashboard/caps", label: "My Caps" };
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
		};
	}

	if (organization) {
		return {
			kind: "organization",
			href: `/dashboard/spaces/${organization.id}`,
			label: organization.name,
		};
	}

	return null;
}

export async function getShareDashboardDestination({
	viewer,
	videoId,
	ownerId,
}: {
	viewer: { id: User.UserId; activeOrganizationId: string | null } | null;
	videoId: Video.VideoId;
	ownerId: User.UserId;
}): Promise<ShareDashboardDestination | null> {
	if (!viewer) return null;

	const isOwner = viewer.id === ownerId;

	const [ownerFolderRows, memberSpaces, memberOrganizations] =
		await Promise.all([
			isOwner
				? db()
						.select({ id: folders.id, name: folders.name })
						.from(videos)
						.innerJoin(folders, eq(folders.id, videos.folderId))
						.where(and(eq(videos.id, videoId), isNull(folders.spaceId)))
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
		ownerFolder: ownerFolderRows[0] ?? null,
		memberSpaces,
		memberOrganizations,
	});
}
