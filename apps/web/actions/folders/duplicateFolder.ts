"use server";

import { db } from "@cap/database";
import { folders, videos, s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { revalidatePath } from "next/cache";
import { getFolderById } from "./getFolderById";

export async function duplicateFolder(
  folderId: string,
  parentId?: string | null
): Promise<string> {
  if (!folderId) throw new Error("Folder ID is required");

  // Get the folder to duplicate
  const folder = await getFolderById(folderId);
  if (!folder) throw new Error("Folder not found");

  // Create the duplicated folder
  const newFolderId = nanoId();
  const now = new Date();
  const newFolder = {
    id: newFolderId,
    name: folder.name,
    color: folder.color,
    organizationId: folder.organizationId,
    createdById: folder.createdById,
    createdAt: now,
    updatedAt: now,
    parentId: parentId ?? null,
  };
  await db().insert(folders).values(newFolder);

  // Duplicate all videos in this folder
  const videosInFolder = await db()
    .select()
    .from(videos)
    .where(eq(videos.folderId, folderId));
  for (const video of videosInFolder) {
    const newVideoId = nanoId();
    await db().insert(videos).values({
      ...video,
      id: newVideoId,
      folderId: newFolderId,
      createdAt: now,
      updatedAt: now,
    });

    // --- S3 Asset Duplication ---
    // Copy all S3 objects from old video to new video
    try {
      const { createBucketProvider } = await import("@/utils/s3");
      let bucketProvider = null;
      let prefix: string | null = null;
      let newPrefix: string | null = null;
      if (video.bucket) {
        // Modern: use custom bucket
        const [bucketRow] = await db().select().from(s3Buckets).where(eq(s3Buckets.id, video.bucket));
        if (bucketRow) {
          bucketProvider = await createBucketProvider(bucketRow);
          prefix = `${video.ownerId}/${video.id}/`;
          newPrefix = `${video.ownerId}/${newVideoId}/`;
        }
      } else if (video.awsBucket) {
        // Legacy: use global/default bucket
        bucketProvider = await createBucketProvider(); // No arg = default/global bucket
        prefix = `${video.ownerId}/${video.id}/`;
        newPrefix = `${video.ownerId}/${newVideoId}/`;
      }
      if (bucketProvider && prefix && newPrefix) {
        const objects = await bucketProvider.listObjects({ prefix });
        if (objects.Contents) {
          for (const obj of objects.Contents) {
            if (!obj.Key) continue;
            const newKey = obj.Key.replace(prefix, newPrefix);
            await bucketProvider.copyObject(`${bucketProvider.name}/${obj.Key}`, newKey);
          }
        }
      }
    } catch (err) {
      console.error("Failed to copy S3 assets for duplicated video", err);
    }
  }

  // Recursively duplicate all child folders
  const childFolders = await db()
    .select()
    .from(folders)
    .where(eq(folders.parentId, folderId));
  for (const child of childFolders) {
    await duplicateFolder(child.id, newFolderId);
  }

  revalidatePath(`/dashboard/caps`);
  return newFolderId;
}
