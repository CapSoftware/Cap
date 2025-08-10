"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, spaceMembers } from "@cap/database/schema";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { uploadSpaceIcon } from "./upload-space-icon";
import { v4 as uuidv4 } from "uuid";
import { nanoIdLength } from "@cap/database/helpers";
import { createBucketProvider } from "@/utils/s3";

export async function updateSpace(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const id = formData.get("id") as string;
  const name = formData.get("name") as string;
  const members = formData.getAll("members[]") as string[];
  const iconFile = formData.get("icon") as File | null;

  const [membership] = await db()
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, user.id)));

  if (!membership) return { success: false, error: "Unauthorized" };

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

  // Handle icon removal if requested
  if (formData.get("removeIcon") === "true") {
    // Remove icon from S3 and set iconUrl to null
    const spaceArr = await db().select().from(spaces).where(eq(spaces.id, id));
    const space = spaceArr[0];
    if (space && space.iconUrl) {
      try {
        const bucketProvider = await createBucketProvider();
        const prevKeyMatch = space.iconUrl.match(/organizations\/.+/);
        if (prevKeyMatch && prevKeyMatch[0])
          await bucketProvider.deleteObject(prevKeyMatch[0]);
      } catch (e) {
        console.warn("Failed to delete old space icon from S3", e);
      }
    }
    await db().update(spaces).set({ iconUrl: null }).where(eq(spaces.id, id));
  } else if (iconFile && iconFile.size > 0) {
    await uploadSpaceIcon(formData, id);
  }

  revalidatePath("/dashboard");
  return { success: true };
}
