import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));

import { GET as infraCard } from "@/app/.well-known/mcp/infra/route";
import { GET as infraCardJson } from "@/app/.well-known/mcp/infra/server-card.json/route";
import { GET as libraryCard } from "@/app/.well-known/mcp/route";
import { GET as libraryCardJson } from "@/app/.well-known/mcp/server-card.json/route";
import { GET as infraProtectedResource } from "@/app/.well-known/oauth-protected-resource/api/developer/mcp/route";
import { GET as libraryProtectedResource } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as rootProtectedResource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as infraLlmsRoute } from "@/app/(infra-site)/infra/llms.txt/route";
import { GET as infraLlmsFullRoute } from "@/app/(infra-site)/infra/llms-full.txt/route";
import { GET as infraMarkdownRoute } from "@/app/infra-markdown/route";
import { CAP_INFRA_AGENT_PROMPT } from "@/data/infra-agent-prompt";
import { INFRA_DOC_SLUGS } from "@/lib/infra-markdown";

const LIBRARY_CARD = `{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "so.cap/cap",
  "title": "Cap",
  "description": "Read-only access to your Cap screen recordings: find recordings by title, get status and share links, and read summaries and timestamped transcripts.",
  "version": "1.0.0",
  "websiteUrl": "https://cap.so/agents",
  "repository": {
    "source": "github",
    "url": "https://github.com/CapSoftware/Cap"
  },
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://cap.so/api/mcp"
    }
  ]
}`;

const LIBRARY_PROTECTED_RESOURCE =
	'{"resource":"https://cap.so/api/mcp","authorization_servers":["https://cap.so"],"scopes_supported":["caps:read"],"bearer_methods_supported":["header"]}';

const headersOf = (response: Response) =>
	Object.fromEntries(response.headers.entries());

describe("the library MCP discovery documents", () => {
	it("stay byte-identical, with their headers", async () => {
		const card = libraryCard();
		expect(await card.text()).toBe(LIBRARY_CARD);
		expect(headersOf(card)).toEqual({
			"access-control-allow-origin": "*",
			"cache-control": "public, max-age=3600",
			"content-type": "application/json; charset=utf-8",
		});

		const cardJson = libraryCardJson();
		expect(await cardJson.text()).toBe(LIBRARY_CARD);
		expect(cardJson.headers.get("content-type")).toBe(
			"application/mcp-server-card+json; charset=utf-8",
		);

		for (const response of [
			libraryProtectedResource(),
			rootProtectedResource(),
		]) {
			expect(await response.text()).toBe(LIBRARY_PROTECTED_RESOURCE);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		}
	});
});

describe("the Cap Infra MCP server card", () => {
	it("is served on its own path and names the hosted server and its bearer key", async () => {
		const card = await infraCard().json();
		expect(card).toMatchObject({
			name: "so.cap/infra",
			title: "Cap Infra",
			websiteUrl: "https://cap.so/docs/api/get-started#10-use-with-agents-mcp",
			remotes: [
				{
					type: "streamable-http",
					url: "https://cap.so/api/developer/mcp",
					headers: [
						{ name: "Authorization", isRequired: true, isSecret: true },
					],
				},
			],
		});
		const typed = infraCardJson();
		expect(typed.headers.get("content-type")).toBe(
			"application/mcp-server-card+json; charset=utf-8",
		);
		expect(await typed.json()).toEqual(card);
	});
});

describe("protected resource metadata for the Cap Infra MCP server", () => {
	it("answers a JSON 404 that says to send the secret key, with no OAuth", async () => {
		const response = infraProtectedResource();
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({
			code: "oauth_not_supported",
			message: "The Cap Infra MCP server does not use OAuth",
			hint: expect.stringContaining("Authorization: Bearer"),
		});
	});
});

describe("/infra as Markdown", () => {
	it("carries the agent prompt the page copies, and the links an agent needs", async () => {
		const response = infraMarkdownRoute(
			new Request("https://cap.so/infra-markdown"),
		);
		expect(response.status).toBe(200);
		expect(headersOf(response)).toMatchObject({
			"content-type": "text/markdown; charset=utf-8",
			vary: "Accept",
		});
		const markdown = await response.text();
		expect(markdown.startsWith("# Cap Infra\n")).toBe(true);
		expect(markdown).toContain(`\`\`\`text\n${CAP_INFRA_AGENT_PROMPT}\n\`\`\``);
		for (const link of [
			"https://cap.so/docs/api/get-started",
			"https://cap.so/openapi.json",
			"https://cap.so/docs/api/webhooks",
			"https://cap.so/docs/api/get-started#10-use-with-agents-mcp",
			"https://cap.so/.well-known/mcp/infra/server-card.json",
			"https://cap.so/llms.txt",
			"npx -y @cap.so/infra-mcp",
		]) {
			expect(markdown).toContain(link);
		}
		expect(markdown).not.toMatch(/<[a-z]/i);
	});

	it("links the origin it was asked on", async () => {
		const markdown = await infraMarkdownRoute(
			new Request("https://preview.example/infra-markdown"),
		).text();
		expect(markdown).toContain("https://preview.example/docs/api/rest-api");
	});
});

describe("/infra/llms.txt", () => {
	it("follows the llms.txt layout and links every Infra doc as Markdown", async () => {
		const response = infraLlmsRoute(
			new Request("https://cap.so/infra/llms.txt"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		const text = await response.text();
		const lines = text.split("\n");
		expect(lines[0]).toBe("# Cap Infra");
		expect(lines[2]?.startsWith("> ")).toBe(true);
		for (const slug of INFRA_DOC_SLUGS) {
			expect(text).toContain(`](https://cap.so/docs/${slug}.md): `);
		}
		for (const link of [
			"https://cap.so/infra/llms-full.txt",
			"https://cap.so/openapi.json",
			"https://cap.so/infra.md",
			"https://cap.so/api/developer/mcp",
			"https://cap.so/.well-known/mcp/infra/server-card.json",
		]) {
			expect(text).toContain(link);
		}
		const links = lines.filter((line) => line.startsWith("- "));
		for (const line of links) {
			expect(line).toMatch(/^- \[[^\]]+\]\([^)]+\)(: .+)?$/);
		}
	});

	it("links the origin it was asked on", async () => {
		const text = await infraLlmsRoute(
			new Request("https://preview.example/infra/llms.txt"),
		).text();
		expect(text).toContain("https://preview.example/docs/api/rest-api.md");
	});
});

describe("/infra/llms-full.txt", () => {
	it("holds the Infra overview and every Infra doc in full, in order", async () => {
		const response = infraLlmsFullRoute(
			new Request("https://cap.so/infra/llms-full.txt"),
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text.startsWith("# Cap Infra\n")).toBe(true);
		expect(text).toContain(CAP_INFRA_AGENT_PROMPT);

		const positions = INFRA_DOC_SLUGS.map((slug) =>
			text.indexOf(`Source: https://cap.so/docs/${slug}\n`),
		);
		for (const position of positions) expect(position).toBeGreaterThan(0);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);

		for (const heading of [
			"# Get Started",
			"# REST API",
			"# Webhooks",
			"# Billing",
		]) {
			expect(text).toContain(`\n${heading}\n`);
		}
		expect(text).not.toMatch(/^<[A-Z]/m);
		expect(text).not.toContain("](/");
	});
});
