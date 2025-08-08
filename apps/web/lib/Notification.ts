// Ideally all the Notification-related types would be in @cap/web-domain
// but @cap/web-api-contract is the closest we have right now

import { notifications, videos, users } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, eq, sql } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { UserPreferences } from "@/app/(org)/dashboard/dashboard-data";
import { revalidatePath } from "next/cache";
import { Notification, NotificationBase } from "@cap/web-api-contract";

export type NotificationType = Notification["type"];

// Notification daata without id, readTime, etc
type NotificationSpecificData = DistributiveOmit<
  Notification,
  keyof NotificationBase
>;

// Replaces author object with authorId since we query for that info.
// If we add more notifications this would probably be better done manually
// Type is weird since we need to operate on each member of the NotificationSpecificData union
type CreateNotificationInput<D = NotificationSpecificData> =
  D extends NotificationSpecificData
    ? D["author"] extends never
      ? D
      : Omit<D, "author"> & { authorId: string }
    : never;

export async function createNotification(
  notification: CreateNotificationInput
) {
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
      .where(eq(videos.id, notification.videoId))
      .limit(1);

    if (!videoResult) {
      throw new Error("Video or owner not found");
    }

    // Skip notification if the video owner is the current user
    if (videoResult.ownerId === notification.authorId) {
      return;
    }

    // Check user preferences
    const preferences = videoResult.preferences as UserPreferences;
    if (preferences?.notifications) {
      const notificationPrefs = preferences.notifications;

      const shouldSkipNotification =
        (notification.type === "comment" && notificationPrefs.pauseComments) ||
        (notification.type === "view" && notificationPrefs.pauseViews) ||
        (notification.type === "reply" && notificationPrefs.pauseReplies) ||
        (notification.type === "reaction" && notificationPrefs.pauseReactions);

      if (shouldSkipNotification) {
        return;
      }
    }

    // Check for existing notification to prevent duplicates
    let hasExistingNotification = false;
    if (notification.type === "view") {
      const [existingNotification] = await db()
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, "view"),
            eq(notifications.recipientId, videoResult.ownerId),
            sql`JSON_EXTRACT(${notifications.data}, '$.videoId') = ${notification.videoId}`,
            sql`JSON_EXTRACT(${notifications.data}, '$.authorId') = ${notification.authorId}`
          )
        )
        .limit(1);

      hasExistingNotification = !!existingNotification;
    } else if (
      notification.type === "comment" ||
      notification.type === "reaction" ||
      notification.type === "reply"
    ) {
      // Check for existing comment notification
      const [existingNotification] = await db()
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, notification.type),
            eq(notifications.recipientId, videoResult.ownerId),
            sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${notification.comment.id}`
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

    if (!videoResult.activeOrganizationId) {
      console.warn(
        `User ${videoResult.ownerId} has no active organization, skipping notification`
      );
      return;
    }

    const { type, ...data } = notification;

    await db().insert(notifications).values({
      id: notificationId,
      orgId: videoResult.activeOrganizationId,
      recipientId: videoResult.ownerId,
      type,
      data,
    });

    revalidatePath("/dashboard");

    return { success: true, notificationId };
  } catch (error) {
    console.error("Error creating notification:", error);
    throw error;
  }
}
