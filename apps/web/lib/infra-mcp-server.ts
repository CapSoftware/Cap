import { serverEnv } from "@cap/env";
import {
	createHostedTools,
	type DocsSource,
	HOSTED_INSTRUCTIONS,
	SERVER_NAME,
	SERVER_VERSION,
} from "@cap/infra-mcp/hosted";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { docToMarkdown } from "@/lib/docs-markdown";
import { inProcessDeveloperFetch } from "@/lib/infra-mcp-rest";
import { getDocBySlug } from "@/utils/docs";

export { INFRA_MCP_PATH } from "@/lib/infra-mcp-path";
export const INFRA_MCP_MAX_BODY_BYTES = 65_536;

export const infraDocsSource: DocsSource = async (page) => {
	const doc = getDocBySlug(`api/${page}`);
	if (!doc) throw new Error(`Missing docs page api/${page}`);
	return docToMarkdown(doc, serverEnv().WEB_URL);
};

export function createInfraMcpServer(options: {
	secretKey: string;
	appId?: string;
	fetch: typeof fetch;
	budgetMs?: number;
}) {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ capabilities: { logging: {} }, instructions: HOSTED_INSTRUCTIONS },
	);
	const tools = createHostedTools({
		apiUrl: serverEnv().WEB_URL,
		secretKey: options.secretKey,
		appId: options.appId,
		fetch: options.fetch,
		log: (line) => console.info(line),
		budgetMs: options.budgetMs,
		docs: infraDocsSource,
	});
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
			},
			(args, ctx) =>
				tool.run(args, {
					signal: ctx.mcpReq.signal,
					progressToken: ctx.mcpReq._meta?.progressToken,
					sendProgress: (params) =>
						ctx.mcpReq.notify({ method: "notifications/progress", params }),
					sendLog: (data) => ctx.mcpReq.log("info", data, SERVER_NAME),
				}),
		);
	}
	return server;
}

export const infraMcpHandler = createMcpHandler(
	({ authInfo, requestInfo }) => {
		if (!authInfo?.token) throw new Error("Missing Cap Infra secret key");
		return createInfraMcpServer({
			secretKey: authInfo.token,
			appId: authInfo.clientId,
			fetch: inProcessDeveloperFetch(requestInfo?.headers ?? new Headers()),
		});
	},
	{ maxSubscriptions: 0, maxRequestBodySize: INFRA_MCP_MAX_BODY_BYTES },
);
