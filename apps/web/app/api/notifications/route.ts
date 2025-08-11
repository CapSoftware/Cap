import { getCurrentUser } from "@cap/database/auth/session";
import { notifications, users } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, ColumnBaseConfig, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { NextResponse } from "next/server";
import { Notification as APINotification } from "@cap/web-api-contract";
import { AvcProfileInfo } from "node_modules/@remotion/media-parser/dist/containers/avc/parse-avc";
import { NotificationType } from "@/lib/Notification";
import { MySqlColumn } from "drizzle-orm/mysql-core";
import { jsonExtractString } from "@/utils/sql";

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
        and(eq(jsonExtractString(notifications.data, "authorId"), users.id))
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

    const formattedCountResults: Record<NotificationType, number> = {
      view: 0,
      comment: 0,
      reply: 0,
      reaction: 0,
      // recordings: 0,
      // mentions: 0,
    };

    countResults.forEach(({ type, count }) => {
      formattedCountResults[type] = Number(count);
    });

    const formattedNotifications = notificationsWithAuthors
      .map(({ notification, author }) => {
        try {
          // all notifications currently require an author
          if (!author) return;

          return APINotification.parse({
            id: notification.id,
            type: notification.type,
            readAt: notification.readAt,
            videoId: notification.data.videoId,
            createdAt: notification.createdAt,
            data: notification.data,
            comment: notification.data.comment,
            author: {
              id: author.id,
              name: author.name ?? "Unknown",
              avatar: author.avatar,
            },
          });
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
