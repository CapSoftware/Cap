"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  organizationMembers,
  organizations,
  users,
  spaces,
} from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { nanoId } from "@cap/database/helpers";

export async function updateActiveOrganization(organizationId: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");

  const [organization] = await db()
    .select({ organization: organizations })
    .from(organizations)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.userId, user.id)
      )
    )
    .where(eq(organizations.id, organizationId));

  if (!organization) throw new Error("Organization not found");

  await db()
    .update(users)
    .set({ activeOrganizationId: organization.organization.id })
    .where(eq(users.id, user.id));

  revalidatePath("/dashboard");
}

export async function createSpace(name: string, description: string | null = null) {
  const user = await getCurrentUser();

  if (!user || !user.activeOrganizationId) {
    return { success: false, error: "User not logged in or no active organization" };
  }

  try {
    await db()
      .insert(spaces)
      .values({
        id: nanoId(),
        name,
        description,
        organizationId: user.activeOrganizationId,
        createdById: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    revalidatePath("/dashboard");
    return { success: true };
  } catch (error) {
    console.error("Error creating space:", error);
    return { success: false, error: "Failed to create space" };
  }
}
