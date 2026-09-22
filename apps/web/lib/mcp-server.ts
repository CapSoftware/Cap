import "server-only";

import type { User } from "@cap/web-domain";
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import {
	createMcpHandler,
	fromJsonSchema,
	McpServer,
} from "@modelcontextprotocol/server";

const cardUri = "ui://cap/recording-card.html";
const readOnly = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
};

const result = (value: Record<string, unknown>) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
	structuredContent: value,
});

const failure = (error: unknown) => ({
	content: [
		{
			type: "text" as const,
			text:
				error instanceof Error &&
				/^(Invalid cursor|Search must|Query must)/.test(error.message)
					? error.message
					: "Cap could not complete this request",
		},
	],
	isError: true,
});

export const createCapMcpServer = (userId: User.UserId) => {
	const server = new McpServer({ name: "Cap", version: "1.0.0" });
	server.registerTool(
		"caps_list",
		{
			title: "List Cap recordings",
			description:
				"Find recordings in your owned Cap library by title. Returns up to 20 recordings and a cursor for the next page.",
			inputSchema: fromJsonSchema<{ search?: string; cursor?: string }>({
				type: "object",
				properties: {
					search: { type: "string", maxLength: 80 },
					cursor: { type: "string", maxLength: 1_024 },
				},
				additionalProperties: false,
			}),
			annotations: readOnly,
		},
		async (input) => {
			try {
				const { listMcpCaps } = await import("./mcp-data");
				return result(await listMcpCaps(userId, input));
			} catch (error) {
				return failure(error);
			}
		},
	);
	server.registerTool(
		"caps_get",
		{
			title: "Get a Cap recording",
			description:
				"Get title, duration, status, and share URL for one recording you own.",
			inputSchema: fromJsonSchema<{ id: string }>({
				type: "object",
				properties: { id: { type: "string", minLength: 5, maxLength: 128 } },
				required: ["id"],
				additionalProperties: false,
			}),
			annotations: readOnly,
		},
		async ({ id }) => {
			try {
				const { getMcpCap } = await import("./mcp-data");
				const cap = await getMcpCap(userId, id);
				return cap ? result(cap) : failure(new Error("Cap not found"));
			} catch (error) {
				return failure(error);
			}
		},
	);
	registerAppTool(
		server,
		"caps_context",
		{
			title: "Read a Cap recording",
			description:
				"Read the summary and up to 30 timestamped transcript cues from one recording you own. Optional query filters cues in that recording.",
			inputSchema: fromJsonSchema<{ id: string; query?: string }>({
				type: "object",
				properties: {
					id: { type: "string", minLength: 5, maxLength: 128 },
					query: { type: "string", maxLength: 80 },
				},
				required: ["id"],
				additionalProperties: false,
			}),
			annotations: readOnly,
			_meta: { ui: { resourceUri: cardUri }, "openai/outputTemplate": cardUri },
		},
		async ({ id, query }) => {
			try {
				const { getMcpCapContext } = await import("./mcp-data");
				const context = await getMcpCapContext(userId, id, query);
				return context ? result(context) : failure(new Error("Cap not found"));
			} catch (error) {
				return failure(error);
			}
		},
	);
	registerAppResource(server, "Cap recording card", cardUri, {}, async () => {
		const { default: card } = await import("./mcp-card-html.json");
		return {
			contents: [
				{ uri: cardUri, mimeType: RESOURCE_MIME_TYPE, text: card.html },
			],
		};
	});
	return server;
};

export const capMcpHandler = createMcpHandler(
	({ authInfo }) => {
		const userId = authInfo?.extra?.userId;
		if (typeof userId !== "string") throw new Error("Missing Cap user");
		return createCapMcpServer(userId as User.UserId);
	},
	{ maxSubscriptions: 0 },
);
