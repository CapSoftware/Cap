import "server-only";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	folders,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	users,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { Folder } from "@cap/web-domain";
import { and, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { revalidatePath } from "next/cache";

export async function getFolderById(folderId: string | undefined) {
	if (!folderId) throw new Error("Folder ID is required");

	const [folder] = await db()
		.select()
		.from(folders)
		.where(eq(folders.id, Folder.FolderId.make(folderId)));

	if (!folder) throw new Error("Folder not found");

	revalidatePath(`/dashboard/folder/${folderId}`);
	return folder;
}

export async function getFolderBreadcrumb(folderId: string) {
	const breadcrumb: Array<{
		id: string;
		name: string;
		color: "normal" | "blue" | "red" | "yellow";
	}> = [];
	let currentFolderId = folderId;

	while (currentFolderId) {
		const folder = await getFolderById(currentFolderId);
		if (!folder) break;

		breadcrumb.unshift({
			id: folder.id,
			name: folder.name,
			color: folder.color,
		});

		if (!folder.parentId) break;
		currentFolderId = folder.parentId;
	}

	revalidatePath(`/dashboard/folder/${folderId}`);
	return breadcrumb;
}

// Helper function to fetch shared spaces data for videos
async function getSharedSpacesForVideos(videoIds: string[]) {
	if (videoIds.length === 0) return {};

	// Fetch space-level sharing
	const spaceSharing = await db()
		.select({
			videoId: spaceVideos.videoId,
			id: spaces.id,
			name: spaces.name,
			organizationId: spaces.organizationId,
			iconUrl: organizations.iconUrl,
		})
		.from(spaceVideos)
		.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
		.innerJoin(organizations, eq(spaces.organizationId, organizations.id))
		.where(
			sql`${spaceVideos.videoId} IN (${sql.join(
				videoIds.map((id) => sql`${id}`),
				sql`, `,
			)})`,
		);

	// Fetch organization-level sharing
	const orgSharing = await db()
		.select({
			videoId: sharedVideos.videoId,
			id: organizations.id,
			name: organizations.name,
			organizationId: organizations.id,
			iconUrl: organizations.iconUrl,
		})
		.from(sharedVideos)
		.innerJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
		.where(
			sql`${sharedVideos.videoId} IN (${sql.join(
				videoIds.map((id) => sql`${id}`),
				sql`, `,
			)})`,
		);

	// Combine and group by videoId
	const sharedSpacesMap: Record<
		string,
		Array<{
			id: string;
			name: string;
			organizationId: string;
			iconUrl: string;
			isOrg: boolean;
		}>
	> = {};

	// Add space-level sharing
	spaceSharing.forEach((space) => {
		const spaces = sharedSpacesMap[space.videoId] ?? []
		sharedSpacesMap[space.videoId] = spaces;
		spaces.push({
			id: space.id,
			name: space.name,
			organizationId: space.organizationId,
			iconUrl: space.iconUrl || "",
			isOrg: false,
		});
	});

	// Add organization-level sharing
	orgSharing.forEach((org) => {
		const spaces = sharedSpacesMap[org.videoId] ?? [];
		sharedSpacesMap[org.videoId] = spaces;

		spaces.push({
			id: org.id,
			name: org.name,
			organizationId: org.organizationId,
			iconUrl: org.iconUrl || "",
			isOrg: true,
		});
	});

	return sharedSpacesMap;
}

export async function getVideosByFolderId(folderId: string) {
	if (!folderId) throw new Error("Folder ID is required");

	const videoData = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			createdAt: videos.createdAt,
			public: videos.public,
			metadata: videos.metadata,
			duration: videos.duration,
			totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
			totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
			sharedOrganizations: sql<{ id: string; name: string; iconUrl: string }[]>`
        COALESCE(
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', ${organizations.id},
              'name', ${organizations.name},
              'iconUrl', ${organizations.iconUrl}
            )
          ),
          JSON_ARRAY()
        )
      `,

			ownerName: users.name,
			effectiveDate: sql<string>`
        COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )
      `,
			hasPassword: sql<number>`IF(${videos.password} IS NULL, 0, 1)`,
		})
		.from(videos)
		.leftJoin(comments, eq(videos.id, comments.videoId))
		.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
		.leftJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
		.leftJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.folderId, folderId))
		.groupBy(
			videos.id,
			videos.ownerId,
			videos.name,
			videos.createdAt,
			videos.public,
			videos.metadata,
			users.name,
		)
		.orderBy(
			desc(sql`COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
      ${videos.createdAt}
    )`),
		);

	// Fetch shared spaces data for all videos
	const videoIds = videoData.map((video) => video.id);
	const sharedSpacesMap = await getSharedSpacesForVideos(videoIds);

	// Process the video data to match the expected format
	const processedVideoData = videoData.map((video) => {
		return {
			id: video.id as Video.VideoId, // Cast to Video.VideoId branded type
			ownerId: video.ownerId,
			name: video.name,
			createdAt: video.createdAt,
			public: video.public,
			totalComments: video.totalComments,
			totalReactions: video.totalReactions,
			sharedOrganizations: Array.isArray(video.sharedOrganizations)
				? video.sharedOrganizations.filter(
					(organization) => organization.id !== null,
				)
				: [],
			sharedSpaces: Array.isArray(sharedSpacesMap[video.id])
				? sharedSpacesMap[video.id]
				: [],
			ownerName: video.ownerName ?? "",
			metadata: video.metadata as
				| {
					customCreatedAt?: string;
					[key: string]: unknown;
				}
				| undefined,
			hasPassword: video.hasPassword === 1,
			foldersData: [], // Empty array since videos in a folder don't need folder data
		};
	});

	revalidatePath(`/dashboard/folder/${folderId}`);

	return processedVideoData;
}

export async function getChildFolders(folderId: Folder.FolderId) {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	const childFolders = await db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			parentId: folders.parentId,
			organizationId: folders.organizationId,
			videoCount: sql<number>`(
        SELECT COUNT(*) FROM videos WHERE videos.folderId = folders.id
      )`,
		})
		.from(folders)
		.where(
			and(
				eq(folders.parentId, folderId),
				eq(folders.organizationId, user.activeOrganizationId),
			),
		);

	revalidatePath(`/dashboard/folder/${folderId}`);

	return childFolders;
}
