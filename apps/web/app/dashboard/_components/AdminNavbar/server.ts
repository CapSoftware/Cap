"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaceMembers, spaces, users } from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateActiveSpace(spaceId: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");

  const [space] = await db()
    .select({ space: spaces })
    .from(spaces)
    .innerJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, user.id))
    )
    .where(eq(spaces.id, spaceId));

  if (!space) throw new Error("Space not found");

  await db()
    .update(users)
    .set({ activeSpaceId: space.space.id })
    .where(eq(users.id, user.id));

  revalidatePath("/dashboard");
}
