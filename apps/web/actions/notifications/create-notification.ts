"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { notifications, videos, users } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, eq, sql } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { UserPreferences } from "@/app/(org)/dashboard/dashboard-data";
import { revalidatePath } from "next/cache";

type NotificationData = (typeof notifications.$inferSelect)["data"];

export const createNotification = async (
  notificationData: NotificationData,
  type: "reaction" | "view" | "comment" | "mention" | "reply"
) => {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("User not found");
  }

  try {
    // First, get the video and owner data
    const [videoResult] = await db()
      .select({
        videoId: videos.id,
        ownerId: users.id,
        activeOrganizationId: users.activeOrganizationId,
        preferences: users.preferences,
      })
      .from(videos)
      .innerJoin(users, eq(users.id, videos.ownerId))
      .where(eq(videos.id, notificationData.videoId))
      .limit(1);

    if (!videoResult) {
      throw new Error("Video or owner not found");
    }

    // Skip notification if the video owner is the current user
    if (videoResult.ownerId === currentUser.id) {
      return;
    }

    // Check user preferences
    const preferences = videoResult.preferences as UserPreferences;
    if (preferences?.notifications) {
      const notificationPrefs = preferences.notifications;

      const shouldSkipNotification =
        (type === "comment" && notificationPrefs.pauseComments) ||
        (type === "reply" && notificationPrefs.pauseReplies) ||
        (type === "view" && notificationPrefs.pauseViews) ||
        (type === "reaction" && notificationPrefs.pauseReactions);

      if (shouldSkipNotification) {
        return;
      }
    }

    // Check for existing notification to prevent duplicates
    let hasExistingNotification = false;
    if (type === "view") {
      const [existingNotification] = await db()
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, "view"),
            eq(notifications.recipientId, videoResult.ownerId),
            sql`JSON_EXTRACT(${notifications.data}, '$.videoId') = ${notificationData.videoId}`,
            sql`JSON_EXTRACT(${notifications.data}, '$.authorId') = ${currentUser.id}`
          )
        )
        .limit(1);

      hasExistingNotification = !!existingNotification;
    } else if (type === "comment" && notificationData.comment?.id) {
      // Check for existing comment notification
      const [existingNotification] = await db()
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, "comment"),
            eq(notifications.recipientId, videoResult.ownerId),
            sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${notificationData.comment?.id}`
          )
        )
        .limit(1);

      hasExistingNotification = !!existingNotification;
    }

    if (hasExistingNotification) {
      return;
    }

    const notificationId = nanoId();
    const now = new Date();

    const data: NotificationData = {
      videoId: notificationData.videoId,
      authorId: currentUser.id,
    };

    if (notificationData.comment?.id) {
      data.comment = notificationData.comment;
    }
    if (notificationData.content) {
      data.content = notificationData.content;
    }

    await db().insert(notifications).values({
      id: notificationId,
      orgId: videoResult.activeOrganizationId,
      recipientId: videoResult.ownerId,
      type: type,
      data: data,
      createdAt: now,
      readAt: null,
    });

    revalidatePath("/dashboard");

    return { success: true, notificationId };
  } catch (error) {
    console.error("Error creating notification:", error);
    throw error;
  }
};
