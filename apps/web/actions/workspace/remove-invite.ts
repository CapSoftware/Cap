"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, spaceInvites } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeWorkspaceInvite(inviteId: string, spaceId: string) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const space = await db()
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);

  if (!space || space.length === 0) {
    throw new Error("Workspace not found");
  }

  if (space[0]?.ownerId !== user.id) {
    throw new Error("Only the owner can remove workspace invites");
  }

  const result = await db()
    .delete(spaceInvites)
    .where(
      and(eq(spaceInvites.id, inviteId), eq(spaceInvites.spaceId, spaceId))
    );

  if (result.rowsAffected === 0) {
    throw new Error("Invite not found");
  }

  revalidatePath("/dashboard/settings/workspace");

  return { success: true };
}
