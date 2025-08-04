import { getCurrentUser } from "@cap/database/auth/session";
import { notifications, users } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { NextResponse } from "next/server";

const notificationDataSchema = z.object({
  authorId: z.string(),
  content: z.string().optional(),
  videoId: z.string(),
});

type NotificationsKeys = (typeof notifications.$inferSelect)["type"];
type NotificationsKeysWithReplies =
  | Exclude<`${NotificationsKeys}s`, "replys">
  | "replies";

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  try {
    const notificationsWithAuthors = await db()
      .select({
        notification: {
          id: notifications.id,
          type: notifications.type,
          data: notifications.data,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
        },
        author: {
          id: users.id,
          name: users.name,
          avatar: users.image,
        },
      })
      .from(notifications)
      .leftJoin(
        users,
        and(
          eq(sql`JSON_EXTRACT(${notifications.data}, '$.authorId')`, users.id)
        )
      )
      .where(
        and(
          eq(notifications.recipientId, currentUser.id),
          eq(notifications.orgId, currentUser.activeOrganizationId)
        )
      )
      .orderBy(
        desc(isNull(notifications.readAt)),
        desc(notifications.createdAt)
      );

    const countResults = await db()
      .select({
        type: notifications.type,
        count: sql`COUNT(*)`.as("count"),
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, currentUser.id),
          eq(notifications.orgId, currentUser.activeOrganizationId)
        )
      )
      .groupBy(notifications.type);

    const formattedCountResults: Record<NotificationsKeysWithReplies, number> =
      {
        views: 0,
        comments: 0,
        replies: 0,
        reactions: 0,
        recordings: 0,
        mentions: 0,
      };

    countResults.forEach(({ type, count }) => {
      formattedCountResults[
        `${
          type === "reply" ? "replies" : `${type}s`
        }` as NotificationsKeysWithReplies
      ] = Number(count);
    });

    const formattedNotifications = notificationsWithAuthors
      .map(({ notification, author }) => {
        try {
          const parsedData = notificationDataSchema.parse(notification.data);
          return {
            id: notification.id,
            content: parsedData.content,
            type: notification.type,
            readAt: notification.readAt,
            videoId: parsedData.videoId,
            createdAt: notification.createdAt,
            data: notification.data,
            author: {
              name: author?.name ?? "Unknown",
              avatar: author?.avatar ?? null,
            },
          };
        } catch (error) {
          console.error("Invalid notification data:", error);
          return null;
        }
      })
      .filter(Boolean);

    return NextResponse.json({
      notifications: formattedNotifications,
      count: formattedCountResults,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return NextResponse.json({
      status: 500,
      error: "Failed to fetch notifications",
    });
  }
}
