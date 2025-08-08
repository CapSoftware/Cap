"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { notifications } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export const markAllAsRead = async () => {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("User not found");
  }

  try {
    await db()
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.recipientId, currentUser.id));
  } catch (error) {
    console.log(error);
    throw new Error("Error marking notifications as read");
  }

  revalidatePath("/dashboard");
};
