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
  videoUploads,
} from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { CurrentUser, Folder } from "@cap/web-domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { Effect } from "effect";
import { revalidatePath } from "next/cache";

export const getFolderById = Effect.fn(function* (folderId: string) {
  if (!folderId) throw new Error("Folder ID is required");
  const db = yield* Database;

  const [folder] = yield* db.execute((db) =>
    db
      .select()
      .from(folders)
      .where(eq(folders.id, Folder.FolderId.make(folderId)))
  );

  if (!folder) throw new Error("Folder not found");

  return folder;
});

export const getFolderBreadcrumb = Effect.fn(function* (
  folderId: Folder.FolderId
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
  videoIds: Video.VideoId[]
) {
  if (videoIds.length === 0) return {};
  const db = yield* Database;

  // Fetch space-level sharing
  const spaceSharing = yield* db.execute((db) =>
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
          sql`, `
        )})`
      )
  );

  // Fetch organization-level sharing
  const orgSharing = yield* db.execute((db) =>
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
        eq(sharedVideos.organizationId, organizations.id)
      )
      .where(
        sql`${sharedVideos.videoId} IN (${sql.join(
          videoIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
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
  folderId: Folder.FolderId
) {
  if (!folderId) throw new Error("Folder ID is required");
  const db = yield* Database;

  const videoData = yield* db.execute((db) =>
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
          { id: string; name: string; iconUrl: string }[]
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
        effectiveDate: sql<string>`
        COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )
      `,
        hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
        hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
          Boolean
        ),
      })
      .from(videos)
      .leftJoin(comments, eq(videos.id, comments.videoId))
      .leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
      .leftJoin(
        organizations,
        eq(sharedVideos.organizationId, organizations.id)
      )
      .leftJoin(users, eq(videos.ownerId, users.id))
      .leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
      .where(eq(videos.folderId, folderId))
      .groupBy(
        videos.id,
        videos.ownerId,
        videos.name,
        videos.createdAt,
        videos.public,
        videos.metadata,
        users.name
      )
      .orderBy(
        desc(sql`COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
      ${videos.createdAt}
    )`)
      )
  );

  // Fetch shared spaces data for all videos
  const videoIds = videoData.map((video) => video.id);
  const sharedSpacesMap = yield* getSharedSpacesForVideos(videoIds);

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
            (organization) => organization.id !== null
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
      hasPassword: video.hasPassword,
      hasActiveUpload: video.hasActiveUpload,
      foldersData: [], // Empty array since videos in a folder don't need folder data
    };
  });

  return processedVideoData;
});

export const getChildFolders = Effect.fn(function* (
  folderId: Folder.FolderId,
  root:
    | { variant: "user" }
    | { variant: "space"; spaceId: string }
    | { variant: "org"; organizationId: string }
) {
  const db = yield* Database;

  const user = yield* CurrentUser;
  if (!user.activeOrganizationId) throw new Error("No active organization");

  const childFolders = yield* db.execute((db) =>
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
          eq(folders.organizationId, user.activeOrganizationId),
          root.variant === "space"
            ? eq(folders.spaceId, root.spaceId)
            : isNull(folders.spaceId)
        )
      )
  );

  return childFolders;
});

export const getAllFolders = Effect.fn(function* (
  root:
    | { variant: "user" }
    | { variant: "space"; spaceId: string }
    | { variant: "org"; organizationId: string }
) {
  const db = yield* Database;
  const user = yield* CurrentUser;

  if (!user.activeOrganizationId) throw new Error("No active organization");

  // Get all folders in one query
  const allFolders = yield* db.execute((db) =>
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
          eq(folders.organizationId, user.activeOrganizationId),
          root.variant === "space"
            ? eq(folders.spaceId, root.spaceId)
            : isNull(folders.spaceId)
        )
      )
  );

  // Define the folder with children type
  type FolderWithChildren = {
    id: string;
    name: string;
    color: "normal" | "blue" | "red" | "yellow";
    parentId: string | null;
    organizationId: string;
    videoCount: number;
    children: FolderWithChildren[];
  };

  // Build hierarchy client-side
  const folderMap = new Map<string, FolderWithChildren>();
  const rootFolders: FolderWithChildren[] = [];

  // First pass: create folder objects with children array
  allFolders.forEach((folder) => {
    folderMap.set(folder.id, { ...folder, children: [] });
  });

  // Second pass: build parent-child relationships
  allFolders.forEach((folder) => {
    const folderWithChildren = folderMap.get(folder.id);

    if (folder.parentId) {
      const parent = folderMap.get(folder.parentId);
      if (parent && folderWithChildren) {
        parent.children.push(folderWithChildren);
      }
    } else {
      if (folderWithChildren) {
        rootFolders.push(folderWithChildren);
      }
    }
  });

  return rootFolders;
});

export const moveVideosToFolder = Effect.fn(function* (
  videoIds: Video.VideoId[],
  targetFolderId: Folder.FolderId | null,
  root?:
    | { variant: "space"; spaceId: string }
    | { variant: "org"; organizationId: string }
) {
  if (videoIds.length === 0) throw new Error("No videos to move");

  const db = yield* Database;
  const user = yield* CurrentUser;

  if (!user.activeOrganizationId) throw new Error("No active organization");

  // Validate that all videos exist and belong to the user
  const existingVideos = yield* db.execute((db) =>
    db
      .select({
        id: videos.id,
        folderId: videos.folderId,
        ownerId: videos.ownerId,
      })
      .from(videos)
      .where(and(inArray(videos.id, videoIds), eq(videos.ownerId, user.id)))
  );

  if (existingVideos.length !== videoIds.length) {
    throw new Error(
      "Some videos not found or you don't have permission to move them"
    );
  }

  // If target folder is specified, validate it exists and user has access
  if (targetFolderId) {
    const targetFolder = yield* getFolderById(targetFolderId);

    if (targetFolder.organizationId !== user.activeOrganizationId) {
      throw new Error("Target folder not found or you don't have access to it");
    }

    // Validate space context if provided
    if (root?.variant === "space" && targetFolder.spaceId !== root.spaceId) {
      throw new Error("Target folder does not belong to the specified space");
    }

    // Block moves into space folders when not operating in that space
    if (root?.variant !== "space" && targetFolder.spaceId !== null) {
      throw new Error(
        "Target folder is scoped to a space and cannot be used here"
      );
    }
  }

  // Determine original folder ids and perform the move based on context
  let originalFolderIds: (string | null)[] = [];
  const videoCountDeltas: Record<string, number> = {};

  if (root?.variant === "space") {
    // Collect originals from space_videos
    const spaceRows = yield* db.execute((db) =>
      db
        .select({
          folderId: spaceVideos.folderId,
          videoId: spaceVideos.videoId,
        })
        .from(spaceVideos)
        .where(
          and(
            eq(spaceVideos.spaceId, root.spaceId),
            inArray(spaceVideos.videoId, videoIds)
          )
        )
    );
    const spaceVideoIds = new Set(spaceRows.map((row) => row.videoId));
    const missingVideoIds = videoIds.filter((id) => !spaceVideoIds.has(id));
    if (missingVideoIds.length > 0) {
      throw new Error(
        "Some videos are not in the specified space or you don't have permission to move them"
      );
    }
    
    // Calculate per-folder decrements
    const folderCounts = new Map<string, number>();
    spaceRows.forEach((row) => {
      if (row.folderId) {
        folderCounts.set(row.folderId, (folderCounts.get(row.folderId) || 0) + 1);
      }
    });
    
    folderCounts.forEach((count, folderId) => {
      videoCountDeltas[folderId] = -count;
    });
    
    originalFolderIds = [...folderCounts.keys()];

    // Update per-space folder placement
    yield* db.execute((db) =>
      db
        .update(spaceVideos)
        .set({ folderId: targetFolderId })
        .where(
          and(
            eq(spaceVideos.spaceId, root.spaceId),
            inArray(spaceVideos.videoId, videoIds)
          )
        )
    );
  } else {
    // ORG/global placement via videos.folderId
    const folderCounts = new Map<string, number>();
    existingVideos.forEach((video) => {
      if (video.folderId) {
        folderCounts.set(video.folderId, (folderCounts.get(video.folderId) || 0) + 1);
      }
    });
    
    folderCounts.forEach((count, folderId) => {
      videoCountDeltas[folderId] = -count;
    });
    
    originalFolderIds = [...folderCounts.keys()];

    yield* db.execute((db) =>
      db
        .update(videos)
        .set({
          folderId: targetFolderId,
          updatedAt: new Date(),
        })
        .where(inArray(videos.id, videoIds))
    );
  }

  // Add increment for target folder if specified
  if (targetFolderId) {
    videoCountDeltas[targetFolderId] = (videoCountDeltas[targetFolderId] || 0) + videoIds.length;
  }

  return {
    movedCount: videoIds.length,
    originalFolderIds,
    targetFolderId,
    videoCountDeltas,
  };
});
