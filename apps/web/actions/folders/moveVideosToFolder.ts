"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { CurrentUser, Video, Folder } from "@cap/web-domain";
import { Effect } from "effect";
import { moveVideosToFolder } from "../../lib/folder";
import { runPromise } from "../../lib/server";
import { revalidatePath } from "next/cache";

interface MoveVideosToFolderParams {
  videoIds: string[];
  targetFolderId: string | null;
  spaceId?: string | null;
}

export async function moveVideosToFolderAction({
  videoIds,
  targetFolderId,
  spaceId,
}: MoveVideosToFolderParams) {
  try {
    const user = await getCurrentUser();
    if (!user || !user.activeOrganizationId) {
      return {
        success: false as const,
        error: "Unauthorized or no active organization",
      };
    }

    const typedVideoIds = videoIds.map((id) => Video.VideoId.make(id));
    const typedTargetFolderId = targetFolderId
      ? Folder.FolderId.make(targetFolderId)
      : null;

    const root = spaceId
      ? { variant: "space" as const, spaceId }
      : { variant: "org" as const, organizationId: user.activeOrganizationId };

    const result = await runPromise(
      moveVideosToFolder(typedVideoIds, typedTargetFolderId, root).pipe(
        Effect.provideService(CurrentUser, user)
      )
    );

    // Revalidate paths
    revalidatePath("/dashboard/caps");

    if (spaceId) {
      revalidatePath(`/dashboard/spaces/${spaceId}`);
      result.originalFolderIds.forEach((folderId) => {
        if (folderId) {
          revalidatePath(`/dashboard/spaces/${spaceId}/folder/${folderId}`);
        }
      });
      if (result.targetFolderId) {
        revalidatePath(
          `/dashboard/spaces/${spaceId}/folder/${result.targetFolderId}`
        );
      }
    } else {
      result.originalFolderIds.forEach((folderId) => {
        if (folderId) {
          revalidatePath(`/dashboard/folder/${folderId}`);
        }
      });
      if (result.targetFolderId) {
        revalidatePath(`/dashboard/folder/${result.targetFolderId}`);
      }
    }

    return {
      success: true as const,
      message: `Successfully moved ${result.movedCount} video${
        result.movedCount !== 1 ? "s" : ""
      } to ${result.targetFolderId ? "folder" : "root"}`,
    };
  } catch (error) {
    console.error("Error moving videos to folder:", error);
    return {
      success: false as const,
      error: error instanceof Error ? error.message : "Failed to move videos",
    };
  }
}
