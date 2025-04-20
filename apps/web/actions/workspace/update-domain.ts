'use server';

import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { addDomain, checkDomainStatus } from "./domain-utils";

export async function updateDomain(domain: string, spaceId: string) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    throw new Error("Only the owner can update the custom domain");
  }

  try {
    const addDomainResponse = await addDomain(domain);

    if (addDomainResponse.error) {
      throw new Error(addDomainResponse.error.message);
    }

    await db
      .update(spaces)
      .set({
        customDomain: domain,
        domainVerified: null,
      })
      .where(eq(spaces.id, spaceId));

    const status = await checkDomainStatus(domain);

    if (status.verified) {
      await db
        .update(spaces)
        .set({
          domainVerified: new Date(),
        })
        .where(eq(spaces.id, spaceId));
    }

    revalidatePath('/dashboard/settings/workspace');
    
    return status;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message);
    }
    throw new Error("Failed to update domain");
  }
} 