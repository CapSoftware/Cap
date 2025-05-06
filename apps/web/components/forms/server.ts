"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { organizationMembers, organizations, users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createOrganization(args: { name: string }) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");

  const organizationId = nanoId();
  await db().insert(organizations).values({
    id: organizationId,
    ownerId: user.id,
    name: args.name,
  });

  await db().insert(organizationMembers).values({
    id: nanoId(),
    userId: user.id,
    role: "owner",
    organizationId,
  });

  await db()
    .update(users)
    .set({ activeOrganizationId: organizationId })
    .where(eq(users.id, user.id));

  revalidatePath("/dashboard");
}
