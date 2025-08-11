"use server";

import { db } from "@cap/database";
import { folders } from "@cap/database/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { revalidatePath } from "next/cache";

export async function createFolder({
  name,
  color,
  spaceId,
  parentId,
}: {
  name: string;
  color: "normal" | "blue" | "red" | "yellow";
  spaceId?: string;
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
    spaceId: spaceId || null,
  };

  await db().insert(folders).values(folder);

  revalidatePath("/dashboard/folder");
  return folder;
}
