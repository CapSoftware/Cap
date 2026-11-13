import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
	ServerNotification,
	ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config";
import { creditLinkFor } from "./credit-link";
import { type ClientTuning, DEFAULT_CLIENT_TUNING, InfraClient } from "./http";
import { createRedactor } from "./redact";
import { ANNOTATIONS, createToolRunner } from "./runner";
import { toolInputSchema } from "./tool";
import { createTools } from "./tools";
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

export const INSTRUCTIONS = [
	"Cap Infra hosts video and turns speech into text, billed from the app's prepaid credit.",
	"Video: videos_upload a local file (or videos_import a public https link to one), videos_wait until it is ready, then use the hlsUrl, mp4Url, posterUrl, shareUrl or embedUrl it returns.",
	"Speech: transcripts_create from a url, a local path or a ready videoId, transcripts_wait, then transcripts_text.",
	"Stored video is billed one month when it becomes ready, then daily until deleted, video that viewers stream is billed per delivered minute, and transcripts are billed per audio hour. Check account_usage before large jobs.",
	"Credit can only be added in the console by a signed-in person. When a tool reports out of credit, give them the addCreditAt link.",
	"For embed options, webhooks, billing rules and anything else in the docs, use docs_read.",
].join(" ");

export function createInfraServer(config: Config, options: ServerOptions = {}) {
	const redact = createRedactor(config.secretKey);
	const write =
		options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const log = (line: string) => write(redact(`${SERVER_NAME}: ${line}`));

	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ capabilities: { logging: {} }, instructions: INSTRUCTIONS },
	);

	const client = new InfraClient(config, {
		...DEFAULT_CLIENT_TUNING,
		...options.client,
	});
	const credit = creditLinkFor(config.consoleUrl, client);
	const tools = createTools({
		config,
		client,
		upload: { ...DEFAULT_UPLOAD_TUNING, ...options.upload },
		wait: { ...DEFAULT_WAIT_TUNING, ...options.wait },
		credit,
	});

	const run = createToolRunner({
		credit,
		redact,
		log,
	});

	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: toolInputSchema(tool.input),
				annotations: { title: tool.title, ...ANNOTATIONS[tool.kind] },
			},
			(args: unknown, extra: Extra) =>
				run(tool, args, {
					signal: extra.signal,
					progressToken: extra._meta?.progressToken,
					sendProgress: (params) =>
						extra.sendNotification({
							method: "notifications/progress",
							params,
						}),
					sendLog: (data) =>
						server.sendLoggingMessage({
							level: "info",
							logger: SERVER_NAME,
							data,
						}),
				}),
		);
	}

	return server;
}
