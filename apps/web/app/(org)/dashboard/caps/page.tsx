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
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Caps } from "./Caps";

export const metadata: Metadata = {
	title: "My Caps — Cap",
};

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
		.where(inArray(spaceVideos.videoId, videoIds));

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
		.where(inArray(sharedVideos.videoId, videoIds));

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
		if (!sharedSpacesMap[space.videoId]) {
			sharedSpacesMap[space.videoId] = [];
		}
		sharedSpacesMap[space.videoId]?.push({
			id: space.id,
			name: space.name,
			organizationId: space.organizationId,
			iconUrl: space.iconUrl || "",
			isOrg: false,
		});
	});

	// Add organization-level sharing
	orgSharing.forEach((org) => {
		if (!sharedSpacesMap[org.videoId]) {
			sharedSpacesMap[org.videoId] = [];
		}
		sharedSpacesMap[org.videoId]?.push({
			id: org.id,
			name: org.name,
			organizationId: org.organizationId,
			iconUrl: org.iconUrl || "",
			isOrg: true,
		});
	});

	return sharedSpacesMap;
}

export default async function CapsPage({
	searchParams,
}: {
	searchParams: { [key: string]: string | string[] | undefined };
}) {
	const user = await getCurrentUser();

	if (!user || !user.id) {
		redirect("/login");
	}

	const userId = user.id;
	const page = Number(searchParams.page) || 1;
	const limit = Number(searchParams.limit) || 15;
	const offset = (page - 1) * limit;

	const totalCountResult = await db()
		.select({ count: count() })
		.from(videos)
		.where(eq(videos.ownerId, userId));

	const totalCount = totalCountResult[0]?.count || 0;

	// Get custom domain and verification status for the user's organization
	const organizationData = await db()
		.select({
			customDomain: organizations.customDomain,
			domainVerified: organizations.domainVerified,
		})
		.from(organizations)
		.where(eq(organizations.id, user.activeOrganizationId))
		.limit(1);

	let customDomain: string | null = null;
	let domainVerified = false;

	if (
		organizationData.length > 0 &&
		organizationData[0] &&
		organizationData[0].customDomain
	) {
		customDomain = organizationData[0].customDomain;
		if (organizationData[0].domainVerified !== null) {
			domainVerified = true;
		}
	}

	const videoData = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			createdAt: videos.createdAt,
			metadata: videos.metadata,
			duration: videos.duration,
			public: videos.public,
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
			hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
			hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
				Boolean,
			),
		})
		.from(videos)
		.leftJoin(comments, eq(videos.id, comments.videoId))
		.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
		.leftJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
		.leftJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(and(eq(videos.ownerId, userId), isNull(videos.folderId)))
		.groupBy(
			videos.id,
			videos.ownerId,
			videos.name,
			videos.createdAt,
			videos.metadata,
			users.name,
		)
		.orderBy(
			desc(sql`COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
      ${videos.createdAt}
    )`),
		)
		.limit(limit)
		.offset(offset);

	const foldersData = await db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			parentId: folders.parentId,
			videoCount: sql<number>`(
        SELECT COUNT(*) FROM videos WHERE videos.folderId = folders.id
      )`,
		})
		.from(folders)
		.where(
			and(
				eq(folders.organizationId, user.activeOrganizationId),
				isNull(folders.parentId),
				isNull(folders.spaceId),
			),
		);

	// Fetch shared spaces data for all videos
	const videoIds = videoData.map((video) => video.id);
	const sharedSpacesMap = await getSharedSpacesForVideos(videoIds);

	const processedVideoData = videoData.map((video) => {
		const { effectiveDate, ...videoWithoutEffectiveDate } = video;

		return {
			...videoWithoutEffectiveDate,
			id: Video.VideoId.make(video.id),
			foldersData,
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
						[key: string]: any;
				  }
				| undefined,
		};
	});

	return (
		<Caps
			data={processedVideoData}
			folders={foldersData}
			customDomain={customDomain}
			domainVerified={domainVerified}
			count={totalCount}
			dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
		/>
	);
}
