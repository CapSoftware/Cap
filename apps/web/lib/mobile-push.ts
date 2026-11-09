import { createHash } from "node:crypto";
import { db } from "@cap/database";
import {
	authApiKeys,
	mobilePushClaims,
	mobilePushTokens,
	users,
	videos,
} from "@cap/database/schema";
import { type User, Video } from "@cap/web-domain";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { after } from "next/server";
import {
	type ApnsConfig,
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

const CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;

const isDuplicateKey = (error: unknown): boolean => {
	const value = error as { code?: string; errno?: number; cause?: unknown };
	if (value?.code === "ER_DUP_ENTRY" || value?.errno === 1062) return true;
	return value?.cause !== undefined && isDuplicateKey(value.cause);
};

/**
 * Views push at most once per Cap per 10-minute clock window. The claim row's primary key makes the
 * first view in a window win atomically, however many viewers arrive together.
 */
export async function claimViewPush(params: {
	recipientId: string;
	videoId: string;
	now?: number;
}) {
	const now = params.now ?? Date.now();
	const window = Math.floor(now / VIEW_PUSH_WINDOW_MS);
	try {
		await db()
			.insert(mobilePushClaims)
			.values({ id: `view:${params.recipientId}:${params.videoId}:${window}` });
	} catch (error) {
		if (isDuplicateKey(error)) return false;
		throw error;
	}
	await db()
		.delete(mobilePushClaims)
		.where(lt(mobilePushClaims.createdAt, new Date(now - CLAIM_RETENTION_MS)))
		.limit(100);
	return true;
}

/** Tokens whose session still exists: a phone that signed out, or lost its session, gets nothing. */
async function liveTokens(userId: string): Promise<PushTarget[]> {
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
	return rows as PushTarget[];
}

async function send(
	config: ApnsConfig,
	targets: PushTarget[],
	message: PushMessage,
) {
	const results = await sendPushes(config, targets, message);
	const invalid = [...results]
		.filter(([, result]) => result === "invalid-token")
		.map(([token]) => token);
	if (invalid.length > 0) {
		await db()
			.delete(mobilePushTokens)
			.where(inArray(mobilePushTokens.token, invalid));
	}
}

export async function deliverPushToUser(
	userId: string,
	message: PushMessage,
): Promise<void> {
	try {
		const config = apnsConfig();
		if (!config) return;
		const targets = await liveTokens(userId);
		if (targets.length > 0) await send(config, targets, message);
	} catch (error) {
		console.error("Failed to deliver push notification", error);
	}
}

export interface NotificationPushInput {
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
		const config = apnsConfig();
		if (!config) return;
		const targets = await liveTokens(input.recipientId);
		if (targets.length === 0) return;
		if (
			(input.type === "view" || input.type === "anon_view") &&
			!(await claimViewPush({
				recipientId: input.recipientId,
				videoId: input.videoId,
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
		await send(
			config,
			targets,
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
