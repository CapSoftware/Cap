"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, organizationInvites } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeOrganizationInvite(
  inviteId: string,
  organizationId: string
) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const organization = await db()
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!organization || organization.length === 0) {
    throw new Error("Organization not found");
  }

  if (organization[0]?.ownerId !== user.id) {
    throw new Error("Only the owner can remove organization invites");
  }

  const result = await db()
    .delete(organizationInvites)
    .where(
      and(
        eq(organizationInvites.id, inviteId),
        eq(organizationInvites.organizationId, organizationId)
      )
    );

  if (result.rowsAffected === 0) {
    throw new Error("Invite not found");
  }

  revalidatePath("/dashboard/settings/organization");

  return { success: true };
}
