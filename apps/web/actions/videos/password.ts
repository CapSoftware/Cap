"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@cap/database/crypto";
import { revalidatePath } from "next/cache";

export async function setVideoPassword(videoId: string, password: string) {
  try {
    const user = await getCurrentUser();

    if (!user || !videoId || typeof password !== "string") {
      throw new Error("Missing required data");
    }

    const [video] = await db()
      .select()
      .from(videos)
      .where(eq(videos.id, videoId));

    if (!video || video.ownerId !== user.id) {
      throw new Error("Unauthorized");
    }

    const hashed = await hashPassword(password);
    await db()
      .update(videos)
      .set({ password: hashed })
      .where(eq(videos.id, videoId));

    revalidatePath("/dashboard/caps");
    revalidatePath("/dashboard/shared-caps");
    revalidatePath(`/s/${videoId}`);

    return "Password updated successfully";
  } catch (error) {
    console.error("Error setting video password:", error);
    throw new Error("Failed to update password");
  }
}

export async function removeVideoPassword(videoId: string) {
  try {
    const user = await getCurrentUser();

    if (!user || !videoId) {
      throw new Error("Missing required data");
    }

    const [video] = await db()
      .select()
      .from(videos)
      .where(eq(videos.id, videoId));

    if (!video || video.ownerId !== user.id) {
      throw new Error("Unauthorized");
    }

    await db()
      .update(videos)
      .set({ password: null })
      .where(eq(videos.id, videoId));

    revalidatePath("/dashboard/caps");
    revalidatePath("/dashboard/shared-caps");
    revalidatePath(`/s/${videoId}`);

    return "Password removed successfully";
  } catch (error) {
    console.error("Error removing video password:", error);
    throw new Error("Failed to remove password");
  }
}

export async function verifyVideoPassword(videoId: string, password: string) {
  try {
    if (!videoId || typeof password !== "string")
      throw new Error("Missing data");

    const [video] = await db()
      .select()
      .from(videos)
      .where(eq(videos.id, videoId));

    if (!video || !video.password) throw new Error("No password set");

    const valid = await verifyPassword(video.password, password);

    if (!valid) throw new Error("Invalid password");

    return "Password verified";
  } catch (error) {
    console.error("Error verifying video password:", error);
    throw new Error("Failed to verify password");
  }
}
