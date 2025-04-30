'use server';

import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { addDomain, checkDomainStatus } from "./domain-utils";

export async function updateDomain(domain: string, organizationId: string) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  if (!organization || organization.ownerId !== user.id) {
    throw new Error("Only the owner can update the custom domain");
  }

  try {
    const addDomainResponse = await addDomain(domain);

    if (addDomainResponse.error) {
      throw new Error(addDomainResponse.error.message);
    }

    await db
      .update(organizations)
      .set({
        customDomain: domain,
        domainVerified: null,
      })
      .where(eq(organizations.id, organizationId));

    const status = await checkDomainStatus(domain);

    if (status.verified) {
      await db
        .update(organizations)
        .set({
          domainVerified: new Date(),
        })
        .where(eq(organizations.id, organizationId));
    }

    revalidatePath("/dashboard/settings/organization");

    return status;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message);
    }
    throw new Error("Failed to update domain");
  }
} 