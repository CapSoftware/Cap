import "server-only";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoIdLong } from "@cap/database/helpers";
import {
	messengerConversations,
	messengerMessages,
	users,
} from "@cap/database/schema";
import { and, asc, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { cookies } from "next/headers";
import { MESSENGER_ADMIN_EMAIL, MESSENGER_ANON_COOKIE } from "./constants";

const anonCookieOptions = {
	httpOnly: true,
	sameSite: "lax" as const,
	secure: process.env.NODE_ENV === "production",
	maxAge: 60 * 60 * 24 * 365,
	path: "/",
};

export const getViewerContext = async () => {
	const [user, cookieStore] = await Promise.all([getCurrentUser(), cookies()]);
	const anonymousId = cookieStore.get(MESSENGER_ANON_COOKIE)?.value ?? null;
	const isAdmin = user?.email === MESSENGER_ADMIN_EMAIL;

	return {
		user,
		anonymousId,
		isAdmin,
	};
};

type ViewerContext = Awaited<ReturnType<typeof getViewerContext>>;
type AdminViewerContext = Omit<ViewerContext, "user" | "isAdmin"> & {
	user: NonNullable<ViewerContext["user"]>;
	isAdmin: true;
};

export const getOrCreateAnonymousId = async () => {
	const cookieStore = await cookies();
	const existing = cookieStore.get(MESSENGER_ANON_COOKIE)?.value;
	if (existing) return existing;

	const nextId = nanoIdLong();
	cookieStore.set(MESSENGER_ANON_COOKIE, nextId, anonCookieOptions);
	return nextId;
};

export const linkAnonymousConversationsToUser = async ({
	userId,
	anonymousId,
}: {
	userId: (typeof users.$inferSelect)["id"];
	anonymousId: string | null;
}) => {
	if (!anonymousId) return;

	const unlinked = await db()
		.select({ id: messengerConversations.id })
		.from(messengerConversations)
		.where(
			and(
				eq(messengerConversations.anonymousId, anonymousId),
				isNull(messengerConversations.userId),
			),
		);
	if (!unlinked.length) return;
	const conversationIds = unlinked.map((conversation) => conversation.id);

	await Promise.all([
		db()
			.update(messengerConversations)
			.set({ userId })
			.where(
				and(
					inArray(messengerConversations.id, conversationIds),
					isNull(messengerConversations.userId),
				),
			),
		db()
			.update(messengerMessages)
			.set({ userId })
			.where(
				and(
					inArray(messengerMessages.conversationId, conversationIds),
					isNull(messengerMessages.userId),
				),
			),
	]);
};

const viewerCanReadConversation = (
	viewer: ViewerContext,
	conversation: { userId: string | null; anonymousId: string | null },
	allowAdmin: boolean,
) => {
	const matchesUser = Boolean(
		viewer.user && conversation.userId === viewer.user.id,
	);
	const matchesAnonymous = Boolean(
		viewer.anonymousId && conversation.anonymousId === viewer.anonymousId,
	);
	return (
		(allowAdmin && viewer.isAdmin) ||
		matchesUser ||
		(matchesAnonymous && (!viewer.user || !conversation.userId))
	);
};

type ConversationSummaryRow = typeof messengerConversations.$inferSelect & {
	userName?: string | null;
	userEmail?: string | null;
};

type LatestMessageSummary = {
	conversationId: string;
	content: string;
	role: typeof messengerMessages.$inferSelect.role;
	createdAt: Date;
};

const appendLatestMessage = async (rows: ConversationSummaryRow[]) => {
	if (!rows.length) {
		return [] as Array<
			ConversationSummaryRow & {
				latestMessage: LatestMessageSummary | null;
			}
		>;
	}

	const messages = await db()
		.select({
			conversationId: messengerMessages.conversationId,
			content: messengerMessages.content,
			role: messengerMessages.role,
			createdAt: messengerMessages.createdAt,
		})
		.from(messengerMessages)
		.where(
			inArray(
				messengerMessages.conversationId,
				rows.map((row) => row.id),
			),
		)
		.orderBy(desc(messengerMessages.createdAt));

	const latestByConversation = new Map<string, LatestMessageSummary>();

	for (const message of messages) {
		if (!latestByConversation.has(message.conversationId)) {
			latestByConversation.set(message.conversationId, message);
		}
	}

	return rows.map((row) => ({
		...row,
		latestMessage: latestByConversation.get(row.id) ?? null,
	}));
};

export const listViewerMessengerConversations = async (limit = 30) => {
	const viewer = await getViewerContext();
	if (viewer.user && viewer.anonymousId) {
		await linkAnonymousConversationsToUser({
			userId: viewer.user.id,
			anonymousId: viewer.anonymousId,
		});
	}

	const whereClause = viewer.user
		? eq(messengerConversations.userId, viewer.user.id)
		: viewer.anonymousId
			? eq(messengerConversations.anonymousId, viewer.anonymousId)
			: null;

	if (!whereClause) {
		return {
			viewer,
			conversations: [] as Array<
				ConversationSummaryRow & {
					latestMessage: LatestMessageSummary | null;
				}
			>,
		};
	}

	const conversations = await db()
		.select()
		.from(messengerConversations)
		.where(whereClause)
		.orderBy(desc(messengerConversations.lastMessageAt))
		.limit(limit);

	return {
		viewer,
		conversations: await appendLatestMessage(conversations),
	};
};

export const listAdminMessengerConversations = async (limit = 80) => {
	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) throw new Error("Unauthorized");

	const rows = await db()
		.select({
			id: messengerConversations.id,
			agent: messengerConversations.agent,
			mode: messengerConversations.mode,
			userId: messengerConversations.userId,
			anonymousId: messengerConversations.anonymousId,
			takeoverByUserId: messengerConversations.takeoverByUserId,
			takeoverAt: messengerConversations.takeoverAt,
			createdAt: messengerConversations.createdAt,
			updatedAt: messengerConversations.updatedAt,
			lastMessageAt: messengerConversations.lastMessageAt,
			userName: users.name,
			userEmail: users.email,
		})
		.from(messengerConversations)
		.leftJoin(users, eq(messengerConversations.userId, users.id))
		.orderBy(desc(messengerConversations.lastMessageAt))
		.limit(limit);

	return {
		viewer,
		conversations: await appendLatestMessage(rows),
	};
};

export const getMessengerConversationForViewer = async ({
	conversationId,
	allowAdmin = false,
}: {
	conversationId: string;
	allowAdmin?: boolean;
}) => {
	const viewer = await getViewerContext();

	const [conversation] = await db()
		.select({
			id: messengerConversations.id,
			agent: messengerConversations.agent,
			mode: messengerConversations.mode,
			userId: messengerConversations.userId,
			anonymousId: messengerConversations.anonymousId,
			takeoverByUserId: messengerConversations.takeoverByUserId,
			takeoverAt: messengerConversations.takeoverAt,
			createdAt: messengerConversations.createdAt,
			updatedAt: messengerConversations.updatedAt,
			lastMessageAt: messengerConversations.lastMessageAt,
			userName: users.name,
			userEmail: users.email,
		})
		.from(messengerConversations)
		.leftJoin(users, eq(messengerConversations.userId, users.id))
		.where(eq(messengerConversations.id, conversationId));

	if (
		!conversation ||
		!viewerCanReadConversation(viewer, conversation, allowAdmin)
	)
		return null;

	const messages = await db()
		.select()
		.from(messengerMessages)
		.where(eq(messengerMessages.conversationId, conversation.id))
		.orderBy(asc(messengerMessages.createdAt), asc(messengerMessages.id));

	return {
		viewer,
		conversation,
		messages,
	};
};

export const getMessengerConversationUpdates = async ({
	conversationId,
	after,
}: {
	conversationId: string;
	after: string | null;
}) => {
	const viewer = await getViewerContext();

	const [conversation] = await db()
		.select({
			mode: messengerConversations.mode,
			userId: messengerConversations.userId,
			anonymousId: messengerConversations.anonymousId,
			cursorId: messengerMessages.id,
			cursorCreatedAt: messengerMessages.createdAt,
		})
		.from(messengerConversations)
		.leftJoin(
			messengerMessages,
			and(
				eq(messengerMessages.id, after ?? ""),
				eq(messengerMessages.conversationId, messengerConversations.id),
			),
		)
		.where(eq(messengerConversations.id, conversationId));
	if (!conversation || !viewerCanReadConversation(viewer, conversation, false))
		return null;
	const { cursorId, cursorCreatedAt } = conversation;

	const messages = await db()
		.select({
			id: messengerMessages.id,
			role: messengerMessages.role,
			content: messengerMessages.content,
			createdAt: messengerMessages.createdAt,
		})
		.from(messengerMessages)
		.where(
			cursorId && cursorCreatedAt
				? and(
						eq(messengerMessages.conversationId, conversationId),
						gte(messengerMessages.createdAt, cursorCreatedAt),
						ne(messengerMessages.id, cursorId),
					)
				: eq(messengerMessages.conversationId, conversationId),
		)
		.orderBy(asc(messengerMessages.createdAt), asc(messengerMessages.id));

	return { mode: conversation.mode, messages };
};

export const requireAdminViewer = async (): Promise<AdminViewerContext> => {
	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) {
		throw new Error("Unauthorized");
	}
	return {
		...viewer,
		user: viewer.user,
		isAdmin: true,
	};
};
