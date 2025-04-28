"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateWorkspaceDetails(
  workspaceName: string,
  allowedEmailDomain: string,
  spaceId: string
) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const space = await db().select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space || space.length === 0) {
    throw new Error("Workspace not found");
  }

  if (space[0]?.ownerId !== user.id) {
    throw new Error("Only the owner can update workspace details");
  }

  await db
    .update(spaces)
    .set({
      name: workspaceName,
      allowedEmailDomain: allowedEmailDomain || null,
    })
    .where(eq(spaces.id, spaceId));

  revalidatePath("/dashboard/settings/workspace");

  return { success: true };
}
