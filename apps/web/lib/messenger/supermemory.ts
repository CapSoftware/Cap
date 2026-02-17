import "server-only";

import { serverEnv } from "@cap/env";
import Supermemory from "supermemory";
import {
	MESSENGER_ADMIN_EMAIL,
	MESSENGER_DEFAULT_KNOWLEDGE_TAG,
} from "./constants";

export type SupermemoryConversationMessage = {
	role: "user" | "assistant";
	content: string;
	timestamp: string;
};

const getApiKey = () => serverEnv().SUPERMEMORY_API_KEY;

let _client: Supermemory | null = null;

const getClient = () => {
	const key = getApiKey();
	if (!key) return null;
	if (_client) return _client;
	_client = new Supermemory({ apiKey: key });
	return _client;
};

export const getKnowledgeTag = () =>
	serverEnv().SUPERMEMORY_KNOWLEDGE_TAG?.trim() ||
	MESSENGER_DEFAULT_KNOWLEDGE_TAG;

export const getIdentityTag = (
	userId: string | null,
	anonymousId: string | null,
) =>
	userId
		? `cap-support-user:${userId}`
		: `cap-support-anon:${anonymousId ?? "unknown"}`;

export const isSupermemoryConfigured = () => Boolean(getApiKey());

const extractSnippet = (result: {
	memory?: string;
	chunk?: string;
	metadata?: { [key: string]: unknown } | null;
}) => {
	const content = result.memory ?? result.chunk ?? "";
	const title =
		(typeof result.metadata?.title === "string" && result.metadata.title) || "";
	const trimmed = content.trim();
	if (!trimmed) return "";
	if (!title) return trimmed;
	return `${title}\n${trimmed}`;
};

export const searchSupermemory = async ({
	query,
	containerTag,
	limit = 4,
}: {
	query: string;
	containerTag: string;
	limit?: number;
}) => {
	if (!query.trim()) return [] as string[];
	if (!containerTag.trim()) return [] as string[];

	const client = getClient();
	if (!client) return [] as string[];

	const response = await client.search.memories({
		q: query,
		containerTag,
		searchMode: "hybrid",
		limit,
	});

	return response.results
		.map(extractSnippet)
		.filter((value) => value.length > 0)
		.map((value) => value.slice(0, 1800));
};

export const storeConversationInSupermemory = async ({
	conversationId,
	containerTag,
	messages,
}: {
	conversationId: string;
	containerTag: string;
	messages: SupermemoryConversationMessage[];
}) => {
	if (!messages.length) return;

	const client = getClient();
	if (!client) return;

	await client.post("/v4/conversations", {
		body: { conversationId, containerTag, messages },
	});
};

export const syncCapKnowledgeBase = async (requestedByEmail: string) => {
	if (requestedByEmail !== MESSENGER_ADMIN_EMAIL) {
		throw new Error("Unauthorized");
	}

	const client = getClient();
	if (!client) {
		throw new Error("SUPERMEMORY_API_KEY is not configured");
	}

	const knowledgeTag = getKnowledgeTag();
	const sources = [
		"https://cap.so",
		"https://cap.so/download",
		"https://cap.so/download/versions",
		"https://cap.so/pricing",
		"https://cap.so/features",
		"https://cap.so/features/instant-mode",
		"https://cap.so/features/studio-mode",
		"https://cap.so/docs",
		"https://cap.so/docs/commercial-license",
		"https://cap.so/faq",
		"https://cap.so/blog",
		"https://cap.so/about",
		"https://cap.so/self-hosting",
		"https://cap.so/testimonials",
		"https://cap.so/student-discount",
		"https://cap.so/deactivate-license",
		"https://cap.so/terms",
		"https://cap.so/privacy",

		"https://cap.so/screen-recorder",
		"https://cap.so/free-screen-recorder",
		"https://cap.so/screen-recorder-mac",
		"https://cap.so/screen-recorder-windows",
		"https://cap.so/screen-recording-software",
		"https://cap.so/loom-alternative",

		"https://cap.so/solutions/remote-team-collaboration",
		"https://cap.so/solutions/employee-onboarding-platform",
		"https://cap.so/solutions/daily-standup-software",
		"https://cap.so/solutions/online-classroom-tools",
		"https://cap.so/solutions/agencies",

		"https://cap.so/tools",
		"https://cap.so/tools/loom-downloader",
		"https://cap.so/tools/video-speed-controller",
		"https://cap.so/tools/trim",
		"https://cap.so/tools/convert",
		"https://cap.so/tools/convert/webm-to-mp4",
		"https://cap.so/tools/convert/mov-to-mp4",
		"https://cap.so/tools/convert/avi-to-mp4",
		"https://cap.so/tools/convert/mkv-to-mp4",
		"https://cap.so/tools/convert/mp4-to-gif",
		"https://cap.so/tools/convert/mp4-to-mp3",
		"https://cap.so/tools/convert/mp4-to-webm",

		"https://github.com/CapSoftware/Cap",
	];

	await client.documents.batchAdd({
		containerTag: knowledgeTag,
		documents: sources,
	});

	return { sources, knowledgeTag };
};
