"use server";

import { db } from "@cap/database";
import { folders } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getFolderById(folderId: string | undefined) {
  if (!folderId) throw new Error("Folder ID is required");

  const [folder] = await db()
    .select()
    .from(folders)
    .where(eq(folders.id, folderId));

  if (!folder) throw new Error("Folder not found");

  revalidatePath(`/dashboard/folder/${folderId}`);
  return folder;
}
