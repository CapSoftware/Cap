import { db } from "@cap/database";
import {
	mobilePushTokens,
	notifications,
	users,
	videos,
} from "@cap/database/schema";
import { type User, Video } from "@cap/web-domain";
import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { after } from "next/server";
import {
	apnsConfig,
	type PushMessage,
	type PushTarget,
	sendPushes,
} from "@/lib/apns";

export type PushNotificationType =
	| "view"
	| "comment"
	| "reply"
	| "reaction"
	| "anon_view";

const VIEW_PUSH_WINDOW_MS = 10 * 60 * 1000;
const BODY_MAX_LENGTH = 140;

const truncate = (value: string, max: number) => {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

export const pushMessageFor = (input: {
	type: PushNotificationType;
	capId: string;
	capName: string | null;
	actorName: string | null;
	content?: string | null;
}): PushMessage => {
	const actor = input.actorName?.trim() || "Someone";
	const content = input.content ? truncate(input.content, BODY_MAX_LENGTH) : "";
	const body = (() => {
		switch (input.type) {
			case "comment":
				return content
					? `${actor} commented: ${content}`
					: `${actor} commented`;
			case "reply":
				return content ? `${actor} replied: ${content}` : `${actor} replied`;
			case "reaction":
				return content ? `${actor} reacted ${content}` : `${actor} reacted`;
			case "view":
			case "anon_view":
				return `${actor} watched your Cap`;
		}
	})();
	return {
		title: truncate(input.capName?.trim() || "Your Cap", 80),
		body,
		capId: input.capId,
	};
};

/** Views come in bursts on a popular Cap, so they push at most once per Cap per window. */
export async function hasRecentViewNotification(params: {
	recipientId: string;
	videoId: string;
	excludeNotificationId: string;
	now?: number;
}) {
	const since = new Date((params.now ?? Date.now()) - VIEW_PUSH_WINDOW_MS);
	const [recent] = await db()
		.select({ id: notifications.id })
		.from(notifications)
		.where(
			and(
				inArray(notifications.type, ["view", "anon_view"]),
				eq(notifications.recipientId, params.recipientId as User.UserId),
				eq(notifications.videoId, params.videoId),
				gte(notifications.createdAt, since),
				ne(notifications.id, params.excludeNotificationId),
			),
		)
		.limit(1);
	return !!recent;
}

export async function deliverPushToUser(
	userId: string,
	message: PushMessage,
): Promise<void> {
	const config = apnsConfig();
	if (!config) return;
	try {
		const rows = await db()
			.select({
				token: mobilePushTokens.token,
				environment: mobilePushTokens.environment,
			})
			.from(mobilePushTokens)
			.where(eq(mobilePushTokens.userId, userId as User.UserId));
		if (rows.length === 0) return;
		const results = await sendPushes(config, rows as PushTarget[], message);
		const invalid = [...results]
			.filter(([, result]) => result === "invalid-token")
			.map(([token]) => token);
		if (invalid.length > 0) {
			await db()
				.delete(mobilePushTokens)
				.where(inArray(mobilePushTokens.token, invalid));
		}
	} catch (error) {
		console.error("Failed to deliver push notification", error);
	}
}

export interface NotificationPushInput {
	notificationId: string;
	type: PushNotificationType;
	recipientId: string;
	videoId: string;
	authorId?: string;
	anonName?: string;
	content?: string | null;
}

export async function deliverNotificationPush(
	input: NotificationPushInput,
): Promise<void> {
	if (!apnsConfig()) return;
	try {
		if (
			(input.type === "view" || input.type === "anon_view") &&
			(await hasRecentViewNotification({
				recipientId: input.recipientId,
				videoId: input.videoId,
				excludeNotificationId: input.notificationId,
			}))
		) {
			return;
		}
		const [video] = await db()
			.select({ name: videos.name })
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(input.videoId)))
			.limit(1);
		let actorName = input.anonName ?? null;
		if (input.authorId) {
			const [author] = await db()
				.select({ name: users.name })
				.from(users)
				.where(eq(users.id, input.authorId as User.UserId))
				.limit(1);
			actorName = author?.name ?? null;
		}
		await deliverPushToUser(
			input.recipientId,
			pushMessageFor({
				type: input.type,
				capId: input.videoId,
				capName: video?.name ?? null,
				actorName,
				content: input.content,
			}),
		);
	} catch (error) {
		console.error("Failed to prepare push notification", error);
	}
}

/** Never blocks the caller: `after()` keeps the function alive until delivery settles. */
export function queueNotificationPush(input: NotificationPushInput): void {
	const delivery = deliverNotificationPush(input);
	try {
		after(delivery);
	} catch {
		// Outside a request scope (scripts, tests): nothing to keep alive.
		void delivery;
	}
}
