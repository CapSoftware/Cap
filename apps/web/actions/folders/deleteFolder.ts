"use server";

import { db } from "@cap/database";
import { folders, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getFolderById } from "./getFolderById";

export async function deleteFolder(folderId: string) {
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

  // Set folderId to parentId for all videos in this folder
  await db()
    .update(videos)
    .set({ folderId: parentId })
    .where(eq(videos.folderId, folderId));

  // Delete the folder itself
  await db().delete(folders).where(eq(folders.id, folderId));
  revalidatePath(`/dashboard/caps`);
}
