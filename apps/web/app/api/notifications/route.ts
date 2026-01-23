import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { notifications, users } from "@inflight/database/schema";
import { Notification as APINotification } from "@inflight/web-api-contract";
import { ImageUploads } from "@inflight/web-backend";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { NotificationType } from "@/lib/Notification";
import { runPromise } from "@/lib/server";
import { jsonExtractString } from "@/utils/sql";

const _notificationDataSchema = z.object({
	authorId: z.string(),
	content: z.string().optional(),
	videoId: z.string(),
});

type NotificationsKeys = (typeof notifications.$inferSelect)["type"];
type NotificationsKeysWithReplies =
	| Exclude<`${NotificationsKeys}s`, "replys">
	| "replies";

export const dynamic = "force-dynamic";

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
				and(eq(jsonExtractString(notifications.data, "authorId"), users.id)),
			)
			.where(
				and(
					eq(notifications.recipientId, currentUser.id),
					eq(notifications.orgId, currentUser.activeOrganizationId),
				),
			)
			.orderBy(
				desc(isNull(notifications.readAt)),
				desc(notifications.createdAt),
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
					eq(notifications.orgId, currentUser.activeOrganizationId),
				),
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

		const formattedNotifications = await Effect.gen(function* () {
			const imageUploads = yield* ImageUploads;

			return yield* Effect.all(
				notificationsWithAuthors.map(({ notification, author }) =>
					Effect.gen(function* () {
						// all notifications currently require an author
						if (!author) return null;

						const resolvedAvatar = author.avatar
							? yield* imageUploads
									.resolveImageUrl(author.avatar)
									.pipe(Effect.catchAll(() => Effect.succeed(null)))
							: null;

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
								avatar: resolvedAvatar,
							},
						});
					}).pipe(
						Effect.catchAll((error) => {
							console.error("Invalid notification data:", error);
							return Effect.succeed(null);
						}),
					),
				),
			);
		})
			.pipe(runPromise)
			.then((results) => results.filter(Boolean));

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
