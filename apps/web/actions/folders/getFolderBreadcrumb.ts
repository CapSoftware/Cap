"use server";

import { revalidatePath } from "next/cache";
import { getFolderById } from "./getFolderById";

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

  revalidatePath(`/dashboard/folder/${folderId}`);
  return breadcrumb;
}
