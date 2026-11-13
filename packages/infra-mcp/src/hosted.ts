import type { z } from "zod";
import { CONSOLE_PATH } from "./config";
import { creditLinkFor } from "./credit-link";
import { DOC_PAGES, type DocPage, type DocsSource } from "./docs";
import { type ClientTuning, InfraClient } from "./http";
import { createRedactor } from "./redact";
import {
	ANNOTATIONS,
	createToolRunner,
	type RunHooks,
	type ToolAnnotations,
	type ToolResult,
} from "./runner";
import { toolInputSchema } from "./tool";
import { createTools } from "./tools";
import { DEFAULT_UPLOAD_TUNING } from "./upload";
import { SERVER_NAME, SERVER_VERSION } from "./version";
import { DEFAULT_WAIT_TUNING, type WaitTuning } from "./wait";

export { DOC_PAGES, SERVER_NAME, SERVER_VERSION };
export type { DocPage, DocsSource, RunHooks, ToolResult };

export const HOSTED_MAX_WAIT_SECONDS = 45;
export const HOSTED_TOOL_BUDGET_MS = 50_000;

export const HOSTED_CLIENT_TUNING: ClientTuning = {
	requestTimeoutMs: 20_000,
	callTimeoutMs: 25_000,
	rateLimitRetries: 1,
	transientRetries: 1,
};

export const HOSTED_WAIT_TUNING: WaitTuning = {
	...DEFAULT_WAIT_TUNING,
	mp4WaitMs: 20_000,
	outputGraceMs: 20_000,
};

export const HOSTED_INSTRUCTIONS = [
	"Cap Infra hosts video and turns speech into text, billed from the app's prepaid credit.",
	"Video: videos_import for a file at a public https link, or videos_create_upload with the file size, upload the parts to the signed links it returns from the machine that holds the file, videos_complete_upload, then videos_wait until it is ready and use the hlsUrl, mp4Url, posterUrl, shareUrl or embedUrl it returns.",
	"Speech: transcripts_create from a public url or a ready videoId, transcripts_wait, then transcripts_text.",
	`Wait tools return within ${HOSTED_MAX_WAIT_SECONDS} seconds; when a result has timedOut, call the same tool again.`,
	"Stored video is billed one month when it becomes ready, then daily until deleted, video that viewers stream is billed per delivered minute, and transcripts are billed per audio hour. Check account_usage before large jobs.",
	"Credit can only be added in the console by a signed-in person. When a tool reports out of credit, give them the addCreditAt link.",
	"For embed options, webhooks, billing rules and anything else in the docs, use docs_read.",
].join(" ");

export type HostedTool = {
	name: string;
	title: string;
	description: string;
	inputSchema: z.ZodObject<z.ZodRawShape, z.core.$strict>;
	annotations: ToolAnnotations & { title: string };
	run: (args: unknown, hooks: RunHooks) => Promise<ToolResult>;
};

export type HostedOptions = {
	apiUrl: string;
	secretKey: string;
	appId?: string;
	fetch: typeof fetch;
	log: (line: string) => void;
	client?: Partial<ClientTuning>;
	wait?: Partial<WaitTuning>;
	budgetMs?: number;
	docs?: DocsSource;
};

export function createHostedTools(options: HostedOptions): HostedTool[] {
	let apiUrl = options.apiUrl;
	while (apiUrl.endsWith("/")) apiUrl = apiUrl.slice(0, -1);
	const config = {
		secretKey: options.secretKey,
		apiUrl,
		consoleUrl: `${apiUrl}${CONSOLE_PATH}`,
	};
	const redact = createRedactor(config.secretKey);
	const client = new InfraClient(
		config,
		{ ...HOSTED_CLIENT_TUNING, ...options.client },
		options.fetch,
	);
	const credit = creditLinkFor(config.consoleUrl, client, options.appId);
	const run = createToolRunner({
		credit,
		redact,
		log: (line) => options.log(redact(`${SERVER_NAME}: ${line}`)),
		budgetMs: options.budgetMs ?? HOSTED_TOOL_BUDGET_MS,
	});
	const tools = createTools({
		config,
		client,
		upload: DEFAULT_UPLOAD_TUNING,
		wait: { ...HOSTED_WAIT_TUNING, ...options.wait },
		surface: "hosted",
		maxWaitSeconds: HOSTED_MAX_WAIT_SECONDS,
		docs: options.docs,
		credit,
	});
	return tools.map((tool) => ({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: toolInputSchema(tool.input),
		annotations: { title: tool.title, ...ANNOTATIONS[tool.kind] },
		run: (args, hooks) => run(tool, args, hooks),
	}));
}
