"use server";

import { db } from "@cap/database";
import { folders } from "@cap/database/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { sql } from "drizzle-orm/sql";
import { revalidatePath } from "next/cache";

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

  revalidatePath(`/dashboard/folder/${folderId}`);

  return childFolders;
}
