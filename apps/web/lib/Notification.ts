import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { comments, notifications, users, videos } from "@cap/database/schema";
import type { Notification, NotificationBase } from "@cap/web-api-contract";
import { type Comment, Video } from "@cap/web-domain";
import { and, eq, gte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { UserPreferences } from "@/app/(org)/dashboard/dashboard-data";
import { getSessionHash } from "@/lib/anonymous-names";

export type NotificationType = Notification["type"];

type NotificationSpecificData = DistributiveOmit<
	Notification,
	keyof NotificationBase
>;

type AuthoredNotificationData = Exclude<
	NotificationSpecificData,
	{ type: "anon_view" }
>;

type CreateNotificationInput<D = AuthoredNotificationData> =
	D extends AuthoredNotificationData
		? Omit<D, "author"> & { authorId: string } & {
				parentCommentId?: Comment.CommentId;
			}
		: never;

const ANON_NOTIF_WINDOW_MS = 5 * 60 * 1000;
const ANON_NOTIF_MAX_PER_VIDEO = 50;

const escapeLikePattern = (value: string) =>
	value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

const isDuplicateEntryError = (error: unknown) => {
	if (!error || typeof error !== "object") return false;
	const duplicateEntryError = error as {
		code?: string;
		errno?: number;
		message?: string;
		sqlMessage?: string;
	};
	if (
		duplicateEntryError.code !== "ER_DUP_ENTRY" &&
		duplicateEntryError.errno !== 1062
	)
		return false;
	const message =
		`${duplicateEntryError.sqlMessage ?? ""} ${duplicateEntryError.message ?? ""}`.trim();
	return message.length === 0 || message.includes("dedup_key_idx");
};

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
					activeOrganizationId: users.activeOrganizationId,
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
				orgId: recipientUser.activeOrganizationId,
				recipientId,
				type,
				data,
			});

			revalidatePath("/dashboard");
			return { success: true, notificationId };
		}

		if (videoResult.ownerId === notification.authorId) {
			return;
		}

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

export async function createAnonymousViewNotification({
	videoId,
	sessionId,
	anonName,
	location,
}: {
	videoId: string;
	sessionId: string;
	anonName: string;
	location: string | null;
}) {
	const sessionHash = getSessionHash(sessionId);
	const dedupKey = `anon_view:${videoId}:${sessionHash}`;
	const rateWindowStart = new Date(Date.now() - ANON_NOTIF_WINDOW_MS);
	const dedupPrefix = `anon_view:${escapeLikePattern(videoId)}:%`;

	try {
		const database = db();

		const [existingNotification] = await database
			.select({ id: notifications.id })
			.from(notifications)
			.where(eq(notifications.dedupKey, dedupKey))
			.limit(1);

		if (existingNotification) return;

		const [videoWithOwner] = await database
			.select({
				videoId: videos.id,
				ownerId: users.id,
				activeOrganizationId: users.activeOrganizationId,
				preferences: users.preferences,
			})
			.from(videos)
			.innerJoin(users, eq(users.id, videos.ownerId))
			.where(eq(videos.id, Video.VideoId.make(videoId)))
			.limit(1);

		if (!videoWithOwner?.activeOrganizationId) return;

		const preferences = videoWithOwner.preferences as UserPreferences;
		if (preferences?.notifications?.pauseAnonViews) return;

		const [recentNotificationCount] = await database
			.select({ count: sql<number>`COUNT(*)` })
			.from(notifications)
			.where(
				and(
					eq(notifications.type, "anon_view"),
					eq(notifications.recipientId, videoWithOwner.ownerId),
					gte(notifications.createdAt, rateWindowStart),
					sql`${notifications.dedupKey} LIKE ${dedupPrefix} ESCAPE '\\\\'`,
				),
			)
			.limit(1);

		if (Number(recentNotificationCount?.count ?? 0) >= ANON_NOTIF_MAX_PER_VIDEO)
			return;

		await database.insert(notifications).values({
			id: nanoId(),
			orgId: videoWithOwner.activeOrganizationId,
			recipientId: videoWithOwner.ownerId,
			type: "anon_view",
			data: { videoId, anonName, location },
			dedupKey,
		});
		revalidatePath("/dashboard");
	} catch (error) {
		if (isDuplicateEntryError(error)) return;
		throw error;
	}
}
