import { z } from "zod";
import { getCurrentUser } from "@cap/database/auth/session";
import { notifications, videos, users } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, eq, sql } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { UserPreferences } from "@/app/(org)/dashboard/dashboard-data";
import { revalidatePath } from "next/cache";

const buildNotification = <TType extends string, TFields extends z.ZodRawShape>(
  type: TType,
  fields: TFields
) => z.object({ ...fields, type: z.literal(type) });

export const Notification = z.union([
  buildNotification("view", { videoId: z.string(), authorId: z.string() }),
  buildNotification("comment", {
    videoId: z.string(),
    authorId: z.string(),
    comment: z.object({
      id: z.string(),
      content: z.string(),
    }),
  }),
  buildNotification("reaction", { videoId: z.string(), authorId: z.string() }),
  // buildNotification("mention", {
  //   videoId: z.string(),
  //   authorId: z.string(),
  //   comment: z.object({
  //     id: z.string(),
  //     content: z.string(),
  //   }),
  // }),
  buildNotification("reply", {
    videoId: z.string(),
    authorId: z.string(),
    comment: z.object({
      id: z.string(),
      content: z.string(),
    }),
  }),
]);

export type RawNotification = z.infer<typeof Notification>;
export type NotificationType = z.infer<typeof Notification>["type"];

export type HydratedNotification =
  | Extract<RawNotification, { type: "view" }>
  | (Extract<RawNotification, { type: "comment" }> & { content: string });

export async function createNotification(notification: RawNotification) {
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
        (notification.type === "view" && notificationPrefs.pauseViews);
      // ||
      // (variant === "reply" && notificationPrefs.pauseReplies) ||
      // (variant === "reaction" && notificationPrefs.pauseReactions);

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
    } else if (notification.type === "comment") {
      // Check for existing comment notification
      const [existingNotification] = await db()
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, "comment"),
            eq(notifications.recipientId, videoResult.ownerId),
            sql`JSON_EXTRACT(${notifications.data}, '$.commentId') = ${notification.comment.id}`
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
