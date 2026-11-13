import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
	CallToolResult,
	ServerNotification,
	ServerRequest,
	ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config";
import {
	ApiError,
	creditNotice,
	isCreditError,
	type ToolError,
	toToolError,
} from "./errors";
import { type ClientTuning, DEFAULT_CLIENT_TUNING, InfraClient } from "./http";
import { createRedactor, redactValue } from "./redact";
import { createTools, type Tool, type ToolCall, type ToolKind } from "./tools";
import { DEFAULT_UPLOAD_TUNING, type UploadTuning } from "./upload";
import { SERVER_NAME, SERVER_VERSION } from "./version";
import { DEFAULT_WAIT_TUNING, type WaitTuning } from "./wait";

export type ServerOptions = {
	client?: Partial<ClientTuning>;
	upload?: Partial<UploadTuning>;
	wait?: Partial<WaitTuning>;
	log?: (line: string) => void;
};

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
	delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export const INSTRUCTIONS = [
	"Cap Infra hosts video and turns speech into text, billed from the app's prepaid credit.",
	"Video: videos_upload a local file, videos_wait until it is ready, then use the hlsUrl, mp4Url, posterUrl, shareUrl or embedUrl it returns.",
	"Speech: transcripts_create from a url, a local path or a ready videoId, transcripts_wait, then transcripts_text.",
	"Stored video is billed one month when it becomes ready, then daily until deleted, and transcripts are billed per audio hour. Check account_usage before large jobs.",
	"Credit can only be added in the console by a signed-in person. When a tool reports out of credit, give them the addCreditAt link.",
].join(" ");

function errorBody(error: ToolError, consoleUrl: string) {
	const api = error instanceof ApiError ? error : null;
	return {
		error: {
			code: error.code,
			message: error.message,
			...(error.hint ? { hint: error.hint } : {}),
			...(api ? { status: api.status, ...api.details } : {}),
			...(api?.retryAfterSeconds
				? { retryAfterSeconds: api.retryAfterSeconds }
				: {}),
		},
		...(isCreditError(error)
			? { credit: creditNotice(consoleUrl), addCreditAt: consoleUrl }
			: {}),
		...error.context,
	};
}

export function createInfraServer(config: Config, options: ServerOptions = {}) {
	const redact = createRedactor(config.secretKey);
	const write =
		options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const log = (line: string) => write(redact(`${SERVER_NAME}: ${line}`));

	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ capabilities: { logging: {} }, instructions: INSTRUCTIONS },
	);

	const tools = createTools({
		config,
		client: new InfraClient(config, {
			...DEFAULT_CLIENT_TUNING,
			...options.client,
		}),
		upload: { ...DEFAULT_UPLOAD_TUNING, ...options.upload },
		wait: { ...DEFAULT_WAIT_TUNING, ...options.wait },
	});

	const result = (body: unknown, isError: boolean): CallToolResult => ({
		content: [
			{ type: "text", text: JSON.stringify(redactValue(redact, body)) },
		],
		...(isError ? { isError: true } : {}),
	});

	const run = async (tool: Tool, args: unknown, extra: Extra) => {
		const progressToken = extra._meta?.progressToken;
		const announce: ToolCall["announce"] = (event, fields) => {
			log(`${event} ${JSON.stringify(redactValue(redact, fields))}`);
			server
				.sendLoggingMessage({
					level: "info",
					logger: SERVER_NAME,
					data: redactValue(redact, { event, ...fields }),
				})
				.catch(() => {});
		};
		const call: ToolCall = {
			signal: extra.signal,
			wantsProgress: progressToken !== undefined,
			announce,
			progress: (done, total, message) => {
				if (progressToken === undefined) return;
				extra
					.sendNotification({
						method: "notifications/progress",
						params: {
							progressToken,
							progress: done,
							...(total === undefined ? {} : { total }),
							message,
						},
					})
					.catch(() => {});
			},
		};

		try {
			return result(await tool.run(args, call), false);
		} catch (thrown) {
			const error = toToolError(thrown);
			const body = errorBody(error, config.consoleUrl);
			if (error.code === "internal_error" && thrown instanceof Error) {
				log(`${tool.name} failed unexpectedly: ${thrown.message}`);
			}
			if (Object.keys(error.context).length > 0) {
				announce(
					extra.signal.aborted
						? `${tool.name}_cancelled`
						: `${tool.name}_failed`,
					{ code: error.code, ...error.context },
				);
			}
			return result(body, true);
		}
	};

	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.input,
				annotations: { title: tool.title, ...ANNOTATIONS[tool.kind] },
			},
			(args: unknown, extra: Extra) => run(tool, args, extra),
		);
	}

	return server;
}
