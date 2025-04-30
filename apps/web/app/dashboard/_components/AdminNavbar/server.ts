"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  organizationMembers,
  organizations,
  users,
} from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateActiveOrganization(organizationId: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");

  const [organization] = await db
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

  await db
    .update(users)
    .set({ activeOrganizationId: organization.organization.id })
    .where(eq(users.id, user.id));

  revalidatePath("/dashboard");
}
