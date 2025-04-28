"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { spaceMembers, spaces, users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createSpace(args: { name: string }) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");

  const spaceId = nanoId();
  await db().insert(spaces).values({
    id: spaceId,
    ownerId: user.id,
    name: args.name,
  });

  await db().insert(spaceMembers).values({
    id: nanoId(),
    userId: user.id,
    role: "owner",
    spaceId,
  });

  await db
    .update(users)
    .set({ activeSpaceId: spaceId })
    .where(eq(users.id, user.id));

  revalidatePath("/dashboard");
}
