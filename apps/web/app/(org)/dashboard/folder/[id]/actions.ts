"use server";

import { db } from "@cap/database";
import { folders } from "@cap/database/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
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

export async function duplicateFolder(folderId: string) {
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
      ),
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
      ...(parentId !== undefined ? { parentId } : {})
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
      ),
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
