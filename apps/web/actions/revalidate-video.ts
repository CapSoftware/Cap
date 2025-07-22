"use server";

import { revalidatePath } from "next/cache";

export async function revalidateVideoPath(videoId: string) {
  try {
    revalidatePath(`/s/${videoId}`);
    return { success: true };
  } catch (error) {
    console.error("Failed to revalidate path:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
