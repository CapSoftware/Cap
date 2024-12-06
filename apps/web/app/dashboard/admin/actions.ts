"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function lookupUserById(data: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.email.endsWith("@cap.so")) return;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, data.get("id") as string));

  return user;
}
