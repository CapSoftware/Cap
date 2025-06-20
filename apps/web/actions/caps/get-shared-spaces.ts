"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  sharedVideos,
  videos,
  spaces,
  organizations,
  spaceVideos,
} from "@cap/database/schema";
import { eq } from "drizzle-orm";

interface Space {
  id: string;
  name: string;
  organizationId: string;
}

export async function getSharedSpacesForCap(capId: string): Promise<Space[]> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return [];
    }

    const [cap] = await db().select().from(videos).where(eq(videos.id, capId));
    if (!cap) {
      return [];
    }

    const directlySharedSpaces = await db()
      .select({
        id: spaces.id,
        name: spaces.name,
        organizationId: spaces.organizationId,
      })
      .from(spaceVideos)
      .innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
      .where(eq(spaceVideos.videoId, capId));

    const sharedOrganizations = await db()
      .select({
        id: organizations.id,
        name: organizations.name,
      })
      .from(sharedVideos)
      .innerJoin(
        organizations,
        eq(sharedVideos.organizationId, organizations.id)
      )
      .where(eq(sharedVideos.videoId, capId));

    const organizationSpaces = sharedOrganizations.map((org) => ({
      id: org.id,
      name: `All ${org.name}`,
      organizationId: org.id,
    }));

    return [...directlySharedSpaces, ...organizationSpaces];
  } catch (error) {
    console.error("Error getting shared spaces for cap:", error);
    return [];
  }
}
