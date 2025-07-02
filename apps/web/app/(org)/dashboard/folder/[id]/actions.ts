"use server";

import { db } from "@cap/database";
import {
  folders,
  videos,
  comments,
  users,
  organizations,
  sharedVideos,
} from "@cap/database/schema";
import { eq, and, desc } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { sql } from "drizzle-orm/sql";
import { revalidatePath } from "next/cache";

export async function getFolderById(folderId: string | undefined) {
  if (!folderId) throw new Error("Folder ID is required");

  const [folder] = await db()
    .select()
    .from(folders)
    .where(eq(folders.id, folderId));

  if (!folder) throw new Error("Folder not found");
  return folder;
}

export async function deleteFolder(folderId: string) {
  if (!folderId) throw new Error("Folder ID is required");

  await db().delete(folders).where(eq(folders.id, folderId));
  revalidatePath(`/dashboard/caps`);
}

export async function duplicateFolder(
  folderId: string,
  parentId?: string | null
) {
  if (!folderId) throw new Error("Folder ID is required");

  const folder = await getFolderById(folderId);

  if (!folder) throw new Error("Folder not found");

  const newFolder = {
    id: nanoId(),
    name: folder.name,
    color: folder.color,
    organizationId: folder.organizationId,
    createdById: folder.createdById,
    createdAt: new Date(),
    updatedAt: new Date(),
    parentId,
  };

  await db().insert(folders).values(newFolder);
  revalidatePath(`/dashboard/caps`);
}

export async function updateFolder({
  folderId,
  name,
  color,
  parentId,
}: {
  folderId: string;
  name?: string;
  color?: "normal" | "blue" | "red" | "yellow";
  parentId?: string | null;
}) {
  const user = await getCurrentUser();
  if (!user || !user.activeOrganizationId)
    throw new Error("Unauthorized or no active organization");

  // If parentId is provided and not null, verify it exists and belongs to the same organization
  if (parentId) {
    // Check that we're not creating a circular reference
    if (parentId === folderId) {
      throw new Error("A folder cannot be its own parent");
    }

    const [parentFolder] = await db()
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.id, parentId),
          eq(folders.organizationId, user.activeOrganizationId)
        )
      );

    if (!parentFolder) {
      throw new Error("Parent folder not found or not accessible");
    }

    // Check for circular references in the folder hierarchy
    let currentParentId = parentFolder.parentId;
    while (currentParentId) {
      if (currentParentId === folderId) {
        throw new Error("Cannot create circular folder references");
      }

      const [nextParent] = await db()
        .select()
        .from(folders)
        .where(eq(folders.id, currentParentId));

      if (!nextParent) break;
      currentParentId = nextParent.parentId;
    }
  }

  await db()
    .update(folders)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
    })
    .where(eq(folders.id, folderId));
  revalidatePath(`/dashboard/caps`);
}

export async function createFolder({
  name,
  color,
  parentId,
}: {
  name: string;
  color: "normal" | "blue" | "red" | "yellow";
  parentId?: string;
}) {
  const user = await getCurrentUser();
  if (!user || !user.activeOrganizationId)
    throw new Error("Unauthorized or no active organization");
  if (!name) throw new Error("Folder name is required");

  // If parentId is provided, verify it exists and belongs to the same organization
  if (parentId) {
    const [parentFolder] = await db()
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.id, parentId),
          eq(folders.organizationId, user.activeOrganizationId)
        )
      );

    if (!parentFolder) {
      throw new Error("Parent folder not found or not accessible");
    }
  }

  const id = nanoId();
  const now = new Date();

  const folder = {
    id,
    name,
    color,
    organizationId: user.activeOrganizationId,
    createdById: user.id,
    parentId: parentId || null,
    createdAt: now,
    updatedAt: now,
  };

  await db().insert(folders).values(folder);
  revalidatePath(`/dashboard/caps`);
  return folder;
}

export async function getChildFolders(folderId: string) {
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
        eq(folders.organizationId, user.activeOrganizationId)
      )
    );

  return childFolders;
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

  return breadcrumb;
}

export async function moveVideoToFolder({
  videoId,
  folderId,
}: {
  videoId: string;
  folderId: string | null;
}) {
  const user = await getCurrentUser();
  if (!user || !user.activeOrganizationId)
    throw new Error("Unauthorized or no active organization");

  if (!videoId) throw new Error("Video ID is required");

  // Get the current video to know its original folder
  const [currentVideo] = await db()
    .select({ folderId: videos.folderId })
    .from(videos)
    .where(eq(videos.id, videoId));

  const originalFolderId = currentVideo?.folderId;

  // If folderId is provided, verify it exists and belongs to the same organization
  if (folderId) {
    const [folder] = await db()
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.id, folderId),
          eq(folders.organizationId, user.activeOrganizationId)
        )
      );

    if (!folder) {
      throw new Error("Folder not found or not accessible");
    }
  }

  // Update the video's folderId
  await db()
    .update(videos)
    .set({
      folderId,
      updatedAt: new Date(),
    })
    .where(eq(videos.id, videoId));

  // Always revalidate the main caps page
  revalidatePath(`/dashboard/caps`);

  // Revalidate the target folder if it exists
  if (folderId) {
    revalidatePath(`/dashboard/folder/${folderId}`);
  }

  // Revalidate the original folder if it exists
  if (originalFolderId) {
    revalidatePath(`/dashboard/folder/${originalFolderId}`);
  }

  // If we're moving from one folder to another, revalidate the parent folders too
  if (originalFolderId && folderId && originalFolderId !== folderId) {
    // Get parent of original folder
    const [originalFolder] = await db()
      .select({ parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.id, originalFolderId));

    if (originalFolder?.parentId) {
      revalidatePath(`/dashboard/folder/${originalFolder.parentId}`);
    }

    // Get parent of target folder
    const [targetFolder] = await db()
      .select({ parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.id, folderId));

    if (targetFolder?.parentId) {
      revalidatePath(`/dashboard/folder/${targetFolder.parentId}`);
    }
  }
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
      sharedSpaces: sql<
        {
          id: string;
          name: string;
          organizationId: string;
          iconUrl: string;
          isOrg: boolean;
        }[]
      >`
        COALESCE(
          (
            SELECT JSON_ARRAYAGG(
              JSON_OBJECT(
                'id', s.id,
                'name', s.name,
                'organizationId', s.organizationId,
                'iconUrl', s.iconUrl,
                'isOrg', s.isOrg
              )
            )
            FROM (
              -- Include spaces where the video is directly added via space_videos
              SELECT DISTINCT 
                s.id, 
                s.name, 
                s.organizationId, 
                o.iconUrl as iconUrl,
                FALSE as isOrg
              FROM space_videos sv
              JOIN spaces s ON sv.spaceId = s.id
              JOIN organizations o ON s.organizationId = o.id
              WHERE sv.videoId = ${videos.id}
              
              UNION
              
              -- For organization-level sharing, include the organization details
              -- and mark it as an organization with isOrg=TRUE
              SELECT DISTINCT 
                o.id as id, 
                o.name as name, 
                o.id as organizationId, 
                o.iconUrl as iconUrl,
                TRUE as isOrg
              FROM shared_videos sv
              JOIN organizations o ON sv.organizationId = o.id
              WHERE sv.videoId = ${videos.id}
            ) AS s
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

  // Process the video data to match the expected format
  const processedVideoData = videoData.map((video) => {
    const { effectiveDate, ...videoWithoutEffectiveDate } = video;

    return {
      ...videoWithoutEffectiveDate,
      sharedOrganizations: video.sharedOrganizations.filter(
        (organization) => organization.id !== null
      ),
      sharedSpaces: video.sharedSpaces.filter((space) => space.id !== null),
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

  return processedVideoData;
}
