import { createHash } from "node:crypto";
import { db } from "@cap/database";
import {
	authApiKeys,
	mobilePushTokens,
	notifications,
	users,
	videos,
} from "@cap/database/schema";
import { type User, Video } from "@cap/web-domain";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
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
const MAX_TOKENS_PER_PUSH = 10;

export const pushSessionHash = (apiKey: string) =>
	createHash("sha256").update(apiKey).digest("hex");

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

/**
 * Views push at most once per Cap per 10-minute clock window: only the window's first view notification
 * pushes, so viewers who arrive together still send exactly one. Ties on createdAt break on id.
 */
export async function isFirstViewInWindow(params: {
	recipientId: string;
	videoId: string;
	notificationId: string;
}) {
	const [own] = await db()
		.select({ createdAt: notifications.createdAt })
		.from(notifications)
		.where(eq(notifications.id, params.notificationId))
		.limit(1);
	if (!own) return false;
	const [first] = await db()
		.select({ id: notifications.id })
		.from(notifications)
		.where(
			and(
				inArray(notifications.type, ["view", "anon_view"]),
				eq(notifications.recipientId, params.recipientId as User.UserId),
				eq(notifications.videoId, params.videoId),
				gte(
					notifications.createdAt,
					new Date(
						Math.floor(own.createdAt.getTime() / VIEW_PUSH_WINDOW_MS) *
							VIEW_PUSH_WINDOW_MS,
					),
				),
				lte(notifications.createdAt, own.createdAt),
			),
		)
		.orderBy(asc(notifications.createdAt), asc(notifications.id))
		.limit(1);
	return first?.id === params.notificationId;
}

export async function deliverPushToUser(
	userId: string,
	message: PushMessage,
): Promise<void> {
	try {
		const config = apnsConfig();
		if (!config) return;
		// Only tokens whose session still exists: a phone that signed out (or lost its session) stops getting pushes.
		const rows = await db()
			.select({
				token: mobilePushTokens.token,
				environment: mobilePushTokens.environment,
			})
			.from(mobilePushTokens)
			.innerJoin(
				authApiKeys,
				and(
					eq(authApiKeys.userId, mobilePushTokens.userId),
					sql`SHA2(${authApiKeys.id}, 256) = ${mobilePushTokens.sessionHash}`,
				),
			)
			.where(eq(mobilePushTokens.userId, userId as User.UserId))
			.orderBy(sql`${mobilePushTokens.updatedAt} DESC`)
			.limit(MAX_TOKENS_PER_PUSH);
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
	try {
		if (!apnsConfig()) return;
		if (
			(input.type === "view" || input.type === "anon_view") &&
			!(await isFirstViewInWindow({
				recipientId: input.recipientId,
				videoId: input.videoId,
				notificationId: input.notificationId,
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
