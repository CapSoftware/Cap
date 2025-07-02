"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { spaceVideos, videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq, and, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeVideosFromSpace(spaceId: string, videoIds: string[]) {
  try {
    const user = await getCurrentUser();

    if (!user || !user.id) {
      throw new Error("Unauthorized");
    }

    if (!spaceId || !videoIds || videoIds.length === 0) {
      throw new Error("Missing required data");
    }

    // Only allow removing videos the user owns
    const userVideos = await db()
      .select({ id: videos.id })
      .from(videos)
      .where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

    const validVideoIds = userVideos.map(v => v.id);

    if (validVideoIds.length === 0) {
      throw new Error("No valid videos found");
    }

    // Remove from spaceVideos
    const deleted = await db()
      .delete(spaceVideos)
      .where(and(
        eq(spaceVideos.spaceId, spaceId),
        inArray(spaceVideos.videoId, validVideoIds)
      ));

    revalidatePath(`/dashboard/spaces/${spaceId}`);

    return {
      success: true,
      message: `Removed ${validVideoIds.length} video(s) from space`,
      deletedCount: validVideoIds.length,
    };

  } catch (error: any) {
    return {
      success: false,
      message: error.message || "Failed to remove videos from space",
    };
  }
}
