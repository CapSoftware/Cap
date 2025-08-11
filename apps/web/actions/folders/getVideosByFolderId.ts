"use server";

import { db } from "@cap/database";
import {
  videos,
  comments,
  users,
  organizations,
  sharedVideos,
  spaceVideos,
  spaces,
} from "@cap/database/schema";
import { eq, desc } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { revalidatePath } from "next/cache";

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
    .where(sql`${spaceVideos.videoId} IN (${sql.join(videoIds.map(id => sql`${id}`), sql`, `)})`);

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
    .where(sql`${sharedVideos.videoId} IN (${sql.join(videoIds.map(id => sql`${id}`), sql`, `)})`);

  // Combine and group by videoId
  const sharedSpacesMap: Record<string, Array<{
    id: string;
    name: string;
    organizationId: string;
    iconUrl: string;
    isOrg: boolean;
  }>> = {};

  // Add space-level sharing
  spaceSharing.forEach(space => {
    if (!sharedSpacesMap[space.videoId]) {
      sharedSpacesMap[space.videoId] = [];
    }
    sharedSpacesMap[space.videoId].push({
      id: space.id,
      name: space.name,
      organizationId: space.organizationId,
      iconUrl: space.iconUrl || '',
      isOrg: false,
    });
  });

  // Add organization-level sharing
  orgSharing.forEach(org => {
    if (!sharedSpacesMap[org.videoId]) {
      sharedSpacesMap[org.videoId] = [];
    }
    sharedSpacesMap[org.videoId].push({
      id: org.id,
      name: org.name,
      organizationId: org.organizationId,
      iconUrl: org.iconUrl || '',
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
      metadata: videos.metadata,
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
      videos.metadata,
      users.name
    )
    .orderBy(
      desc(sql`COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
      ${videos.createdAt}
    )`)
    );

  // Fetch shared spaces data for all videos
  const videoIds = videoData.map(video => video.id);
  const sharedSpacesMap = await getSharedSpacesForVideos(videoIds);

  // Process the video data to match the expected format
  const processedVideoData = videoData.map((video) => {
    const { effectiveDate, ...videoWithoutEffectiveDate } = video;

    return {
      ...videoWithoutEffectiveDate,
      sharedOrganizations: Array.isArray(video.sharedOrganizations)
        ? video.sharedOrganizations.filter((organization) => organization.id !== null)
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
      hasPassword: video.hasPassword === 1,
    };
  });

  revalidatePath(`/dashboard/folder/${folderId}`);

  return processedVideoData;
}
