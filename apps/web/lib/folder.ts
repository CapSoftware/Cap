import "server-only";

import {
	comments,
	folders,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Database, ImageUploads } from "@cap/web-backend";
import type { ImageUpload, Organisation, Space, Video } from "@cap/web-domain";
import { CurrentUser, Folder } from "@cap/web-domain";
import { and, desc, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { Effect } from "effect";

export const getFolderById = Effect.fn(function* (folderId: string) {
	if (!folderId) throw new Error("Folder ID is required");
	const db = yield* Database;

	const [folder] = yield* db.use((db) =>
		db
			.select()
			.from(folders)
			.where(eq(folders.id, Folder.FolderId.make(folderId))),
	);

	if (!folder) throw new Error("Folder not found");

	return folder;
});

export const getFolderBreadcrumb = Effect.fn(function* (
	folderId: Folder.FolderId,
) {
	const breadcrumb: Array<{
		id: Folder.FolderId;
		name: string;
		color: "normal" | "blue" | "red" | "yellow";
	}> = [];
	let currentFolderId = folderId;

	while (currentFolderId) {
		const folder = yield* getFolderById(currentFolderId);
		if (!folder) break;

		breadcrumb.unshift({
			id: folder.id,
			name: folder.name,
			color: folder.color,
		});

		if (!folder.parentId) break;
		currentFolderId = folder.parentId;
	}

	return breadcrumb;
});

// Helper function to fetch shared spaces data for videos
const getSharedSpacesForVideos = Effect.fn(function* (
	videoIds: Video.VideoId[],
) {
	if (videoIds.length === 0) return {};
	const db = yield* Database;

	// Fetch space-level sharing
	const spaceSharing = yield* db.use((db) =>
		db
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
			),
	);

	// Fetch organization-level sharing
	const orgSharing = yield* db.use((db) =>
		db
			.select({
				videoId: sharedVideos.videoId,
				id: organizations.id,
				name: organizations.name,
				organizationId: organizations.id,
				iconUrl: organizations.iconUrl,
			})
			.from(sharedVideos)
			.innerJoin(
				organizations,
				eq(sharedVideos.organizationId, organizations.id),
			)
			.where(
				sql`${sharedVideos.videoId} IN (${sql.join(
					videoIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			),
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
		const spaces = sharedSpacesMap[space.videoId] ?? [];
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
});

export const getVideosByFolderId = Effect.fn(function* (
	folderId: Folder.FolderId,
	root:
		| { variant: "user" }
		| { variant: "space"; spaceId: Space.SpaceIdOrOrganisationId }
		| { variant: "org"; organizationId: Organisation.OrganisationId },
) {
	if (!folderId) throw new Error("Folder ID is required");
	const db = yield* Database;
	const imageUploads = yield* ImageUploads;

	const videoData = yield* db.use((db) =>
		db
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
				sharedOrganizations: sql<
					{
						id: string;
						name: string;
						iconUrl: ImageUpload.ImageUrlOrKey | null;
					}[]
				>`
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
				effectiveDate: videos.effectiveCreatedAt,
				hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
				hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
					Boolean,
				),
				source: videos.source,
			})
			.from(videos)
			.leftJoin(comments, eq(videos.id, comments.videoId))
			.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
			.leftJoin(spaceVideos, eq(videos.id, spaceVideos.videoId))
			.leftJoin(
				organizations,
				eq(sharedVideos.organizationId, organizations.id),
			)
			.leftJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(
				root.variant === "space"
					? and(
							eq(spaceVideos.folderId, folderId),
							isNull(organizations.tombstoneAt),
						)
					: root.variant === "org"
						? and(
								eq(sharedVideos.folderId, folderId),
								isNull(organizations.tombstoneAt),
							)
						: eq(videos.folderId, folderId),
			)
			.groupBy(
				videos.id,
				videos.ownerId,
				videos.name,
				videos.createdAt,
				videos.public,
				videos.metadata,
				users.name,
			)
			.orderBy(desc(videos.effectiveCreatedAt)),
	);

	// Fetch shared spaces data for all videos
	const videoIds = videoData.map((video) => video.id);
	const sharedSpacesMap = yield* getSharedSpacesForVideos(videoIds);

	// Process the video data to match the expected format
	const processedVideoData = yield* Effect.all(
		videoData.map(
			Effect.fn(function* (video) {
				return {
					id: video.id as Video.VideoId, // Cast to Video.VideoId branded type
					ownerId: video.ownerId,
					name: video.name,
					createdAt: video.createdAt,
					public: video.public,
					totalComments: video.totalComments,
					totalReactions: video.totalReactions,
					sharedOrganizations: yield* Effect.all(
						(video.sharedOrganizations ?? [])
							.filter((organization) => organization.id !== null)
							.map(
								Effect.fn(function* (org) {
									return {
										...org,
										iconUrl: org.iconUrl
											? yield* imageUploads.resolveImageUrl(org.iconUrl)
											: null,
									};
								}),
							),
					),
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
					hasPassword: video.hasPassword,
					hasActiveUpload: video.hasActiveUpload,
					source: video.source as { type: string } | undefined,
					foldersData: [], // Empty array since videos in a folder don't need folder data
				};
			}),
		),
	);

	return processedVideoData;
});

export const getChildFolders = Effect.fn(function* (
	folderId: Folder.FolderId,
	root:
		| { variant: "user" }
		| { variant: "space"; spaceId: Space.SpaceIdOrOrganisationId }
		| { variant: "org"; organizationId: Organisation.OrganisationId },
) {
	const db = yield* Database;

	const user = yield* CurrentUser;
	if (!user.activeOrganizationId) throw new Error("No active organization");

	const childFolders = yield* db.use((db) =>
		db
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
					root.variant === "space"
						? eq(folders.spaceId, root.spaceId)
						: undefined,
				),
			),
	);

	return childFolders;
});
