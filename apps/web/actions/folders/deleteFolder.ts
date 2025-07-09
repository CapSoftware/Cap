"use server";

import { db } from "@cap/database";
import { folders, videos, spaceVideos } from "@cap/database/schema";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getFolderById } from "./getFolderById";

export async function deleteFolder(folderId: string, spaceId?: string | null) {
  if (!folderId) throw new Error("Folder ID is required");

  // Get the folder to find its parent
  const folder = await getFolderById(folderId);
  const parentId = folder.parentId ?? null;

  // Recursively delete all child folders first
  const childFolders = await db()
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.parentId, folderId));
  for (const child of childFolders) {
    await deleteFolder(child.id);
  }

  // Always update videos.folderId so videos move up to parent folder
  await db()
    .update(videos)
    .set({ folderId: parentId })
    .where(eq(videos.folderId, folderId));

  // If spaceId is provided, also update spaceVideos.folderId for consistency
  if (spaceId) {
    await db()
      .update(spaceVideos)
      .set({ folderId: parentId })
      .where(
        and(
          eq(spaceVideos.folderId, folderId),
          eq(spaceVideos.spaceId, spaceId)
        )
      );
  }

  // Delete the folder itself
  await db().delete(folders).where(eq(folders.id, folderId));
  if (spaceId) {
    revalidatePath(`/dashboard/spaces/${spaceId}`);
  } else {
    revalidatePath(`/dashboard/caps`);
  }
}
