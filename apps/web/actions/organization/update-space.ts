"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, spaceMembers } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { uploadIcon } from "./upload-icon";
import { v4 as uuidv4 } from "uuid";
import { nanoIdLength } from "@cap/database/helpers";

export async function updateSpace(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return { success: false, error: "Unauthorized" };
  const id = formData.get("id") as string;
  const name = formData.get("name") as string;
  const members = formData.getAll("members[]") as string[];
  const iconFile = formData.get("icon") as File | null;

  // Update space name
  await db().update(spaces).set({ name }).where(eq(spaces.id, id));

  // Update members (simple replace for now)
  await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, id));
  if (members.length > 0) {
    await db()
      .insert(spaceMembers)
      .values(
        members.map((userId) => ({
          id: uuidv4().substring(0, nanoIdLength),
          spaceId: id,
          userId,
        }))
      );
  }

  // Update icon if provided
  if (iconFile && iconFile.size > 0) {
    await uploadIcon(id, iconFile);
  }

  revalidatePath("/dashboard");
  return { success: true };
}
