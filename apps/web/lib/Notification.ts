// Ideally all the Notification-related types would be in @cap/web-domain
// but @cap/web-api-contract is the closest we have right now

import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { comments, notifications, users, videos } from "@cap/database/schema";
import type { Notification, NotificationBase } from "@cap/web-api-contract";
import { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { UserPreferences } from "@/app/(org)/dashboard/dashboard-data";

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
			: Omit<D, "author"> & { authorId: string } & { parentCommentId?: string }
		: never;

export async function createNotification(
	notification: CreateNotificationInput,
) {
	try {
		const [videoExists] = await db()
			.select({ id: videos.id, ownerId: videos.ownerId })
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(notification.videoId)))
			.limit(1);

		if (!videoExists) {
			console.error("Video not found for videoId:", notification.videoId);
			throw new Error(`Video not found for videoId: ${notification.videoId}`);
		}

		const [ownerResult] = await db()
			.select({
				id: users.id,
				activeOrganizationId: users.activeOrganizationId,
				preferences: users.preferences,
			})
			.from(users)
			.where(eq(users.id, videoExists.ownerId))
			.limit(1);

		if (!ownerResult) {
			console.warn(
				"Owner not found for videoId:",
				notification.videoId,
				"ownerId:",
				videoExists.ownerId,
				"- skipping notification creation",
			);
			return;
		}

		const videoResult = {
			videoId: videoExists.id,
			ownerId: ownerResult.id,
			activeOrganizationId: ownerResult.activeOrganizationId,
			preferences: ownerResult.preferences,
		};

		const { type, ...data } = notification;

		// Handle replies: notify the parent comment's author
		if (type === "reply" && notification.parentCommentId) {
			const [parentComment] = await db()
				.select({ authorId: comments.authorId })
				.from(comments)
				.where(eq(comments.id, notification.parentCommentId))
				.limit(1);

			const recipientId = parentComment?.authorId;
			if (!recipientId) return;
			if (recipientId === videoResult.ownerId) return;

			const [recipientUser] = await db()
				.select({
					preferences: users.preferences,
				})
				.from(users)
				.where(eq(users.id, recipientId))
				.limit(1);

			if (!recipientUser) {
				console.warn(`Reply recipient user ${recipientId} not found`);
				return;
			}

			const recipientPrefs = recipientUser.preferences as
				| UserPreferences
				| undefined;
			if (recipientPrefs?.notifications?.pauseReplies) return;

			const [existingReply] = await db()
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.type, "reply"),
						eq(notifications.recipientId, recipientId),
						sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${notification.comment.id}`,
					),
				)
				.limit(1);

			if (existingReply) return;

			const notificationId = nanoId();

			await db().insert(notifications).values({
				id: notificationId,
				orgId: undefined, // TODO: BRUHHHHH: recipientUser.activeOrganizationId,
				recipientId,
				type,
				data,
			});

			revalidatePath("/dashboard");
			return { success: true, notificationId };
		}

		// Skip notification if the video owner is the current user
		// (this only applies to non-reply types)
		if (videoResult.ownerId === notification.authorId) {
			return;
		}

		// Check user preferences
		const preferences = videoResult.preferences as UserPreferences;
		if (preferences?.notifications) {
			const notificationPrefs = preferences.notifications;

			const shouldSkipNotification =
				(type === "comment" && notificationPrefs.pauseComments) ||
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
						sql`JSON_EXTRACT(${notifications.data}, '$.videoId') = ${notification.videoId}`,
						sql`JSON_EXTRACT(${notifications.data}, '$.authorId') = ${notification.authorId}`,
					),
				)
				.limit(1);

			hasExistingNotification = !!existingNotification;
		} else if (type === "comment" || type === "reaction") {
			const [existingNotification] = await db()
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.type, type),
						eq(notifications.recipientId, videoResult.ownerId),
						sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${notification.comment.id}`,
					),
				)
				.limit(1);

			hasExistingNotification = !!existingNotification;
		}

		if (hasExistingNotification) {
			return;
		}

		const notificationId = nanoId();

		if (!videoResult.activeOrganizationId) {
			console.warn(
				`User ${videoResult.ownerId} has no active organization, skipping notification`,
			);
			return;
		}

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
