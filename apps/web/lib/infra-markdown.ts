import { infraSeo } from "@/components/pages/infra/content";
import {
	CAP_INFRA_AGENT_PROMPT,
	CAP_INFRA_MCP_URL,
} from "@/data/infra-agent-prompt";
import { docToMarkdown } from "@/lib/docs-markdown";
import { getDocBySlug } from "@/utils/docs";

export const INFRA_DOC_SLUGS = [
	"api/get-started",
	"api/rest-api",
	"api/webhooks",
	"api/billing",
] as const;

const infraDocs = () =>
	INFRA_DOC_SLUGS.map((slug) => {
		const doc = getDocBySlug(slug);
		if (!doc) throw new Error(`Missing Cap Infra doc: ${slug}`);
		return doc;
	});

export const infraMarkdown = (origin: string) =>
	[
		"# Cap Infra",
		"",
		infraSeo.description,
		"",
		"## Set it up with an agent",
		"",
		"Give this prompt to your coding agent. It is the same prompt the Copy prompt button on this page copies.",
		"",
		"```text",
		CAP_INFRA_AGENT_PROMPT,
		"```",
		"",
		"## Links",
		"",
		`- Get started, from a new app to a playing video: ${origin}/docs/api/get-started`,
		`- REST reference: ${origin}/docs/api/rest-api`,
		`- OpenAPI 3.1 description: ${origin}/openapi.json`,
		`- Webhooks: ${origin}/docs/api/webhooks`,
		`- Billing: ${origin}/docs/api/billing`,
		`- Hosted MCP server: ${CAP_INFRA_MCP_URL}, with the secret key as Authorization: Bearer. Setup: ${origin}/docs/api/get-started#10-use-with-agents-mcp`,
		`- MCP server card: ${origin}/.well-known/mcp/infra/server-card.json`,
		"- Local MCP server, which uploads a file from disk in one call: npx -y @cap.so/infra-mcp with the key in CAP_SECRET_KEY. Setup: https://www.npmjs.com/package/@cap.so/infra-mcp",
		`- Console, where an app and its keys are created: ${origin}/dashboard/infra`,
		`- Every Cap Infra doc in one Markdown file: ${origin}/infra/llms-full.txt`,
		`- Everything about Cap for agents: ${origin}/llms.txt`,
		"",
		"Every page under /docs is also available as Markdown: add .md to its URL or send Accept: text/markdown.",
		"",
	].join("\n");

export const infraLlmsTxt = (origin: string) =>
	[
		"# Cap Infra",
		"",
		`> ${infraSeo.description}`,
		"",
		"Cap Infra is an API, separate from the Cap screen recorder. It needs no Cap Desktop, no `cap` CLI and no user sign-in, only an app's secret key (`csk_`) sent as `Authorization: Bearer` from server code. Take every path and field name from the OpenAPI description.",
		"",
		"## Docs",
		"",
		...infraDocs().map(
			(doc) =>
				`- [${doc.metadata.title}](${origin}/docs/${doc.slug}.md): ${doc.metadata.summary ?? doc.metadata.title}`,
		),
		`- [All of the above in one file](${origin}/infra/llms-full.txt): every Cap Infra doc as Markdown`,
		"",
		"## API",
		"",
		`- [OpenAPI 3.1 description](${origin}/openapi.json): every path, field and error code`,
		`- [Agent setup prompt](${origin}/infra.md): the prompt to give a coding agent, and the links it needs`,
		`- [Console](${origin}/dashboard/infra): where an app, its keys and its credit are managed`,
		"",
		"## MCP",
		"",
		`- [Hosted MCP server](${CAP_INFRA_MCP_URL}): Streamable HTTP, the secret key as Authorization: Bearer, no OAuth. Setup: ${origin}/docs/api/get-started#10-use-with-agents-mcp`,
		`- [Server card](${origin}/.well-known/mcp/infra/server-card.json): the hosted server's MCP server card`,
		"- [Local MCP server](https://www.npmjs.com/package/@cap.so/infra-mcp): `npx -y @cap.so/infra-mcp` with the key in CAP_SECRET_KEY, uploads a file from disk in one call",
		"",
		"## Optional",
		"",
		`- [Cap for agents](${origin}/llms.txt): the Cap screen recorder, its CLI and its MCP server`,
		"",
	].join("\n");

export const infraLlmsFullTxt = (origin: string) =>
	[
		infraMarkdown(origin).trimEnd(),
		...infraDocs().map((doc) =>
			[
				"",
				"---",
				"",
				`Source: ${origin}/docs/${doc.slug}`,
				"",
				docToMarkdown(doc, origin).trimEnd(),
			].join("\n"),
		),
		"",
	].join("\n");
