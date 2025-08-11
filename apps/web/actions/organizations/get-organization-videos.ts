"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

export async function getOrganizationVideoIds(organizationId: string) {
  try {
    const user = await getCurrentUser();

    if (!user || !user.id) {
      throw new Error("Unauthorized");
    }

    if (!organizationId) {
      throw new Error("Organization ID is required");
    }

    const videoIds = await db()
      .select({
        videoId: sharedVideos.videoId,
      })
      .from(sharedVideos)
      .where(eq(sharedVideos.organizationId, organizationId));

    return { 
      success: true, 
      data: videoIds.map(v => v.videoId) 
    };
  } catch (error) {
    console.error("Error fetching organization video IDs:", error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : "Failed to fetch organization videos" 
    };
  }
} 