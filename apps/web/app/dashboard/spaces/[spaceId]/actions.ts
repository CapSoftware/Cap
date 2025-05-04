"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  videos as caps,
  spaces,
  organizations,
  users,
  spaceVideos,
} from "@cap/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getSpace(spaceId: string) {
  const user = await getCurrentUser();
  
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }
  
  try {
    const space = await db()
      .select({
        id: spaces.id,
        name: spaces.name,
        description: spaces.description,
        createdAt: spaces.createdAt,
        organizationId: spaces.organizationId,
        createdById: spaces.createdById,
      })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .then(spaces => spaces[0]);
      
    if (!space) {
      return { success: false, error: "Space not found" };
    }
    
    // Check if user has access to the organization this space belongs to
    const hasAccess = await db()
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.id, space.organizationId),
          eq(organizations.ownerId, user.id)
        )
      )
      .then(orgs => orgs.length > 0);
    
    if (!hasAccess && user.id !== space.createdById) {
      return { success: false, error: "You don't have access to this space" };
    }

    return { success: true, space };
  } catch (error) {
    console.error("Error fetching space:", error);
    return { success: false, error: "Failed to fetch space" };
  }
}

export async function getSpaceCaps(spaceId: string) {
  const user = await getCurrentUser();
  
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }
  
  try {
    // First check if user has access to the space
    const spaceResult = await getSpace(spaceId);
    
    if (!spaceResult.success || !spaceResult.space) {
      return { success: false, error: spaceResult.error || "Space not found" };
    }
    
    // Fetch caps for this space using the space_videos junction table
    const spaceCapsData = await db()
      .select({
        id: caps.id,
        ownerId: caps.ownerId,
        name: caps.name,
        createdAt: caps.createdAt,
      })
      .from(spaceVideos)
      .innerJoin(caps, eq(spaceVideos.videoId, caps.id))
      .where(eq(spaceVideos.spaceId, spaceId))
      .limit(30);
      
    // Join with users to get owner names and add mock analytics data
    const capsWithOwnerNames = await Promise.all(
      spaceCapsData.map(async (data) => {
        const owner = await db()
          .select({
            name: users.name,
          })
          .from(users)
          .where(eq(users.id, data.ownerId))
          .then(users => users[0]);
          
        return {
          id: data.id,
          ownerId: data.ownerId,
          name: data.name,
          createdAt: data.createdAt,
          // Mock analytics data for now
          totalComments: 0,
          totalReactions: 0,
          ownerName: owner?.name,
        };
      })
    );
    
    return { success: true, caps: capsWithOwnerNames };
  } catch (error) {
    console.error("Error fetching space caps:", error);
    return { success: false, error: "Failed to fetch caps for this space" };
  }
}

export async function removeCapFromSpace(capId: string, spaceId: string) {
  const user = await getCurrentUser();
  
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }
  
  try {
    // Delete the entry from space_videos junction table
    await db()
      .delete(spaceVideos)
      .where(
        and(
          eq(spaceVideos.spaceId, spaceId),
          eq(spaceVideos.videoId, capId)
        )
      );
    
    revalidatePath(`/dashboard/spaces/${spaceId}`);
    return { success: true };
  } catch (error) {
    console.error("Error removing cap from space:", error);
    return { success: false, error: "Failed to remove cap from space" };
  }
} 