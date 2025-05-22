"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { VideoMetadata } from "@cap/database/types";

export async function editLogo(
  videoId: string,
  logoUrl: string | null,
  width: number | null,
  useOrganization: boolean,
) {
  const user = await getCurrentUser();

  if (!user || !videoId) {
    throw new Error("Missing required data for updating logo");
  }

  const userId = user.id;
  const query = await db().select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    throw new Error("Video not found");
  }

  const video = query[0];
  if (!video) {
    throw new Error("Video not found");
  }

  if (video.ownerId !== userId) {
    throw new Error("You don't have permission to update this video");
  }

  const currentMetadata = (video.metadata as VideoMetadata) || {};
  const updatedMetadata: VideoMetadata = {
    ...currentMetadata,
    customLogo:
      logoUrl || useOrganization
        ? {
            url: logoUrl || undefined,
            width: width || undefined,
            useOrganization,
          }
        : null,
  };

  try {
    await db()
      .update(videos)
      .set({ metadata: updatedMetadata })
      .where(eq(videos.id, videoId));

    revalidatePath(`/s/${videoId}`);

    return { success: true };
  } catch (error) {
    console.error("Error updating logo:", error);
    if (error instanceof Error) {
      throw new Error(error.message);
    }
    throw new Error("Failed to update logo");
  }
}
