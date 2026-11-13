import { infraSeo } from "@/components/pages/infra/content";
import {
	CAP_INFRA_AGENT_PROMPT,
	CAP_INFRA_MCP_URL,
} from "@/data/infra-agent-prompt";

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
		`- Console, where an app and its keys are created: ${origin}/dashboard/infra`,
		`- Everything about Cap for agents: ${origin}/llms.txt`,
		"",
		"Every page under /docs is also available as Markdown: add .md to its URL or send Accept: text/markdown.",
		"",
	].join("\n");
