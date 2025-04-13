"use server";

import { db } from "@cap/database";
import { spaces } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function getSpace(spaceId: string) {
  if (!spaceId) {
    throw new Error("Space ID is required");
  }

  const [space] = await db
    .select({
      workosOrganizationId: spaces.workosOrganizationId,
      workosConnectionId: spaces.workosConnectionId,
      name: spaces.name,
    })
    .from(spaces)
    .where(eq(spaces.id, spaceId));

  if (!space || !space.workosOrganizationId || !space.workosConnectionId) {
    throw new Error("Space not found or SSO not configured");
  }

  return {
    organizationId: space.workosOrganizationId,
    connectionId: space.workosConnectionId,
    name: space.name,
  };
} 