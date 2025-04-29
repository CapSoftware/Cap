"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { checkDomainStatus } from "./domain-utils";

export async function checkWorkspaceDomain(spaceId: string) {
  const user = await getCurrentUser();

  if (!user || !spaceId) {
    throw new Error("Unauthorized");
  }

  const [space] = await db()
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    throw new Error("Only the owner can check domain status");
  }

  if (!space.customDomain) {
    throw new Error("No custom domain set");
  }

  try {
    const status = await checkDomainStatus(space.customDomain);

    if (status.verified && !space.domainVerified) {
      await db()
        .update(spaces)
        .set({
          domainVerified: new Date(),
        })
        .where(eq(spaces.id, spaceId));
    } else if (!status.verified && space.domainVerified) {
      await db()
        .update(spaces)
        .set({
          domainVerified: null,
        })
        .where(eq(spaces.id, spaceId));
    }

    return status;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message);
    }
    throw new Error("Failed to check domain status");
  }
}
