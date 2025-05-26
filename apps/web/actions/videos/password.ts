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
      return {
        success: false,
        message: "Missing required data",
      };
    }

    const [video] = await db().select().from(videos).where(eq(videos.id, videoId));
    
    if (!video || video.ownerId !== user.id) {
      return {
        success: false,
        message: "Unauthorized",
      };
    }

    const hashed = await hashPassword(password);
    await db().update(videos).set({ password: hashed }).where(eq(videos.id, videoId));

    revalidatePath("/dashboard/caps");
    revalidatePath("/dashboard/shared-caps");
    revalidatePath(`/s/${videoId}`);

    return {
      success: true,
      message: "Password updated successfully",
    };
  } catch (error) {
    console.error("Error setting video password:", error);
    return {
      success: false,
      message: "Failed to update password",
    };
  }
}

export async function removeVideoPassword(videoId: string) {
  try {
    const user = await getCurrentUser();

    if (!user || !videoId) {
      return {
        success: false,
        message: "Missing required data",
      };
    }

    const [video] = await db().select().from(videos).where(eq(videos.id, videoId));
    
    if (!video || video.ownerId !== user.id) {
      return {
        success: false,
        message: "Unauthorized",
      };
    }

    await db().update(videos).set({ password: null }).where(eq(videos.id, videoId));

    revalidatePath("/dashboard/caps");
    revalidatePath("/dashboard/shared-caps");
    revalidatePath(`/s/${videoId}`);

    return {
      success: true,
      message: "Password removed successfully",
    };
  } catch (error) {
    console.error("Error removing video password:", error);
    return {
      success: false,
      message: "Failed to remove password",
    };
  }
}

export async function verifyVideoPassword(videoId: string, password: string) {
  try {
    if (!videoId || typeof password !== "string") {
      return {
        success: false,
        message: "Missing data",
      };
    }

    const [video] = await db().select().from(videos).where(eq(videos.id, videoId));
    
    if (!video || !video.password) {
      return {
        success: false,
        message: "No password set",
      };
    }

    const valid = await verifyPassword(video.password, password);
    
    if (!valid) {
      return {
        success: false,
        message: "Invalid password",
      };
    }

    return {
      success: true,
      message: "Password verified",
    };
  } catch (error) {
    console.error("Error verifying video password:", error);
    return {
      success: false,
      message: "Failed to verify password",
    };
  }
} 