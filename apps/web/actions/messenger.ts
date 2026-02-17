"use server";

import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	messengerConversations,
	messengerMessages,
} from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { asc, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateMessengerAgentReply } from "@/lib/messenger/agent";
import { MESSENGER_AGENT } from "@/lib/messenger/constants";
import {
	getMessengerConversationForViewer,
	getOrCreateAnonymousId,
	getViewerContext,
	linkAnonymousConversationsToUser,
	listAdminMessengerConversations,
	listConversationMessages,
	listViewerMessengerConversations,
	requireAdminViewer,
} from "@/lib/messenger/data";
import {
	getIdentityTag,
	storeConversationInSupermemory,
	syncCapKnowledgeBase,
} from "@/lib/messenger/supermemory";

const normalizeContent = (content: string) => content.trim().slice(0, 6000);

const assertMessengerEnabled = () => {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
		throw new Error("Messenger is disabled");
	}
};

const revalidateMessengerPaths = (conversationId?: string) => {
	revalidatePath("/messenger");
	revalidatePath("/admin");
	if (conversationId) {
		revalidatePath(`/messenger/${conversationId}`);
		revalidatePath(`/admin?conversation=${conversationId}`);
	}
};

const persistConversationToSupermemory = async ({
	conversationId,
	userId,
	anonymousId,
}: {
	conversationId: string;
	userId: string | null;
	anonymousId: string | null;
}) => {
	const messages = await listConversationMessages(conversationId);
	if (!messages.length) return;

	await storeConversationInSupermemory({
		conversationId,
		containerTag: getIdentityTag(userId, anonymousId),
		messages: messages.map((message: (typeof messages)[number]) => ({
			role: message.role === "user" ? "user" : "assistant",
			content: message.content,
			timestamp: message.createdAt.toISOString(),
		})),
	});
};

export const createMessengerConversation = async () => {
	assertMessengerEnabled();

	const viewer = await getViewerContext();
	const anonymousId = viewer.user
		? viewer.anonymousId
		: await getOrCreateAnonymousId();

	if (viewer.user && viewer.anonymousId) {
		await linkAnonymousConversationsToUser({
			userId: viewer.user.id,
			anonymousId: viewer.anonymousId,
		});
	}

	const whereClause = viewer.user
		? eq(messengerConversations.userId, viewer.user.id)
		: anonymousId
			? eq(messengerConversations.anonymousId, anonymousId)
			: null;

	if (whereClause) {
		const [latest] = await db()
			.select({ id: messengerConversations.id })
			.from(messengerConversations)
			.where(whereClause)
			.orderBy(desc(messengerConversations.createdAt))
			.limit(1);

		if (latest) {
			const [hasMessage] = await db()
				.select({ id: messengerMessages.id })
				.from(messengerMessages)
				.where(eq(messengerMessages.conversationId, latest.id))
				.limit(1);

			if (!hasMessage) {
				return latest.id;
			}
		}
	}

	const agentId = MESSENGER_AGENT.id;
	const conversationId = nanoId();

	await db()
		.insert(messengerConversations)
		.values({
			id: conversationId,
			agent: agentId,
			mode: "agent",
			userId: viewer.user?.id ?? null,
			anonymousId: anonymousId ?? null,
		});

	revalidateMessengerPaths(conversationId);
	return conversationId;
};

export const sendMessengerUserMessage = async ({
	conversationId,
	content,
}: {
	conversationId: string;
	content: string;
}) => {
	assertMessengerEnabled();
	const normalized = normalizeContent(content);
	if (!conversationId || !normalized) throw new Error("Message is empty");

	const viewer = await getViewerContext();
	const activeAnonymousId = viewer.user
		? viewer.anonymousId
		: (viewer.anonymousId ?? (await getOrCreateAnonymousId()));

	if (viewer.user && activeAnonymousId) {
		await linkAnonymousConversationsToUser({
			userId: viewer.user.id,
			anonymousId: activeAnonymousId,
		});
	}

	const [conversation] = await db()
		.select()
		.from(messengerConversations)
		.where(eq(messengerConversations.id, conversationId));

	if (!conversation) throw new Error("Conversation not found");

	const matchesUser = Boolean(
		viewer.user && conversation.userId === viewer.user.id,
	);
	const matchesAnonymous = Boolean(
		activeAnonymousId && conversation.anonymousId === activeAnonymousId,
	);
	const matchesAnonymousAsVisitor = Boolean(!viewer.user && matchesAnonymous);
	const shouldAttachUser = Boolean(
		viewer.user && !conversation.userId && matchesAnonymous,
	);

	if (!matchesUser && !matchesAnonymousAsVisitor && !shouldAttachUser) {
		throw new Error("Unauthorized");
	}

	const now = new Date();

	await db()
		.insert(messengerMessages)
		.values({
			id: nanoId(),
			conversationId,
			role: "user",
			content: normalized,
			userId: viewer.user?.id ?? null,
			anonymousId: activeAnonymousId ?? null,
			createdAt: now,
		});

	await db()
		.update(messengerConversations)
		.set({
			lastMessageAt: now,
			userId: shouldAttachUser
				? (viewer.user?.id ?? null)
				: conversation.userId,
		})
		.where(eq(messengerConversations.id, conversationId));

	const effectiveUserId = shouldAttachUser
		? (viewer.user?.id ?? null)
		: conversation.userId;
	const effectiveAnonymousId =
		conversation.anonymousId ?? activeAnonymousId ?? null;

	if (conversation.mode === "human") {
		await persistConversationToSupermemory({
			conversationId,
			userId: effectiveUserId,
			anonymousId: effectiveAnonymousId,
		}).catch(() => undefined);
		revalidateMessengerPaths(conversationId);
		return { mode: "human" as const };
	}

	const history = await db()
		.select({
			role: messengerMessages.role,
			content: messengerMessages.content,
		})
		.from(messengerMessages)
		.where(eq(messengerMessages.conversationId, conversationId))
		.orderBy(asc(messengerMessages.createdAt));

	const identity = viewer.user
		? `${viewer.user.name ?? "User"} <${viewer.user.email}>`
		: `Anonymous visitor (${effectiveAnonymousId ?? "unknown"})`;

	const reply = await generateMessengerAgentReply({
		userIdentity: identity,
		identityTag: getIdentityTag(effectiveUserId, effectiveAnonymousId),
		query: normalized,
		history,
	});

	const responseAt = new Date();
	await db().insert(messengerMessages).values({
		id: nanoId(),
		conversationId,
		role: "agent",
		content: reply,
		userId: null,
		anonymousId: effectiveAnonymousId,
		createdAt: responseAt,
	});

	await db()
		.update(messengerConversations)
		.set({ lastMessageAt: responseAt })
		.where(eq(messengerConversations.id, conversationId));

	await persistConversationToSupermemory({
		conversationId,
		userId: effectiveUserId,
		anonymousId: effectiveAnonymousId,
	}).catch(() => undefined);

	revalidateMessengerPaths(conversationId);
	return { mode: "agent" as const };
};

export const adminSetMessengerMode = async ({
	conversationId,
	mode,
}: {
	conversationId: string;
	mode: "agent" | "human";
}) => {
	assertMessengerEnabled();
	const viewer = await requireAdminViewer();
	const now = new Date();

	await db()
		.update(messengerConversations)
		.set(
			mode === "human"
				? {
						mode,
						takeoverByUserId: viewer.user.id,
						takeoverAt: now,
					}
				: {
						mode,
						takeoverByUserId: null,
						takeoverAt: null,
					},
		)
		.where(eq(messengerConversations.id, conversationId));

	revalidateMessengerPaths(conversationId);
};

export const adminSendMessengerMessage = async ({
	conversationId,
	content,
}: {
	conversationId: string;
	content: string;
}) => {
	assertMessengerEnabled();
	const viewer = await requireAdminViewer();
	const normalized = normalizeContent(content);
	if (!normalized) throw new Error("Message is empty");

	const [conversation] = await db()
		.select()
		.from(messengerConversations)
		.where(eq(messengerConversations.id, conversationId));
	if (!conversation) throw new Error("Conversation not found");

	const now = new Date();
	await db().insert(messengerMessages).values({
		id: nanoId(),
		conversationId,
		role: "admin",
		content: normalized,
		userId: viewer.user.id,
		anonymousId: conversation.anonymousId,
		createdAt: now,
	});

	await db()
		.update(messengerConversations)
		.set({
			mode: "human",
			takeoverByUserId: viewer.user.id,
			takeoverAt: now,
			lastMessageAt: now,
		})
		.where(eq(messengerConversations.id, conversationId));

	await persistConversationToSupermemory({
		conversationId,
		userId: conversation.userId,
		anonymousId: conversation.anonymousId,
	}).catch(() => undefined);

	revalidateMessengerPaths(conversationId);
};

export const adminSyncMessengerKnowledge = async () => {
	assertMessengerEnabled();
	const viewer = await requireAdminViewer();
	const result = await syncCapKnowledgeBase(viewer.user.email);
	revalidatePath("/admin");
	return result;
};

export const fetchMessengerConversations = async () => {
	assertMessengerEnabled();
	const { conversations } = await listViewerMessengerConversations();
	return conversations.map((c) => ({
		id: c.id,
		agent: c.agent,
		latestMessage: c.latestMessage
			? {
					content: c.latestMessage.content,
					createdAt: c.latestMessage.createdAt.toISOString(),
				}
			: null,
		lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
	}));
};

export const fetchMessengerConversation = async (conversationId: string) => {
	assertMessengerEnabled();
	const data = await getMessengerConversationForViewer({ conversationId });
	if (!data) throw new Error("Conversation not found");
	return {
		conversation: {
			id: data.conversation.id,
			agent: data.conversation.agent,
			mode: data.conversation.mode as "agent" | "human",
		},
		messages: data.messages.map((m) => ({
			id: m.id,
			role: m.role as "user" | "agent" | "admin",
			content: m.content,
			createdAt: m.createdAt.toISOString(),
		})),
	};
};

export const fetchAdminConversations = async () => {
	assertMessengerEnabled();
	const { conversations } = await listAdminMessengerConversations();
	return conversations.map((c) => ({
		id: c.id,
		agent: c.agent,
		mode: c.mode as "agent" | "human",
		userId: c.userId,
		anonymousId: c.anonymousId,
		userName: c.userName ?? null,
		userEmail: c.userEmail ?? null,
		lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
		latestMessage: c.latestMessage
			? {
					content: c.latestMessage.content,
					role: c.latestMessage.role as "user" | "agent" | "admin",
					createdAt: c.latestMessage.createdAt.toISOString(),
				}
			: null,
	}));
};

export const fetchAdminConversation = async (conversationId: string) => {
	assertMessengerEnabled();
	const data = await getMessengerConversationForViewer({
		conversationId,
		allowAdmin: true,
	});
	if (!data) throw new Error("Conversation not found");
	return {
		conversation: {
			id: data.conversation.id,
			agent: data.conversation.agent,
			mode: data.conversation.mode as "agent" | "human",
			userId: data.conversation.userId,
			anonymousId: data.conversation.anonymousId,
			userName: data.conversation.userName ?? null,
			userEmail: data.conversation.userEmail ?? null,
		},
		messages: data.messages.map((m) => ({
			id: m.id,
			role: m.role as "user" | "agent" | "admin",
			content: m.content,
			createdAt: m.createdAt.toISOString(),
		})),
	};
};
