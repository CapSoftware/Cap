import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAP_INFRA_AGENT_PROMPT } from "@/data/infra-agent-prompt";
import { developerOpenApiSpec } from "@/lib/developer-openapi";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const documented = new Set(
	Object.entries(developerOpenApiSpec("https://cap.so").paths).flatMap(
		([path, operations]) =>
			METHODS.filter((method) => method in operations).map(
				(method) => `${method.toUpperCase()} ${path}`,
			),
	),
);

const named = (text: string) =>
	[...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/api\/[^\s,.;:)]+)/g)].map(
		([, method, path]) => `${method} ${path}`,
	);

describe("Cap Infra agent prompt", () => {
	it("names only methods and paths that the OpenAPI document has", () => {
		const calls = named(CAP_INFRA_AGENT_PROMPT);
		expect(calls.length).toBeGreaterThanOrEqual(12);
		for (const call of calls) {
			expect(documented, `${call} is not in the OpenAPI document`).toContain(
				call,
			);
		}
		const pathMentions =
			CAP_INFRA_AGENT_PROMPT.match(/\/api\/developer\//g) ?? [];
		expect(pathMentions).toHaveLength(calls.length);
	});

	it("catches a path or a method the API does not have", () => {
		expect(documented).not.toContain("GET /api/developer/v1/apps");
		expect(documented).not.toContain("DELETE /api/developer/v1/usage");
		expect(named("call POST /api/developer/v1/apps, then stop")).toEqual([
			"POST /api/developer/v1/apps",
		]);
	});

	it("covers the whole job with the secret key and the REST API", () => {
		for (const call of [
			"POST /api/developer/v1/uploads",
			"POST /api/developer/v1/uploads/{id}/token",
			"POST /api/developer/sdk/v1/upload/multipart/initiate",
			"POST /api/developer/sdk/v1/upload/multipart/presign-part",
			"POST /api/developer/sdk/v1/upload/multipart/complete",
			"GET /api/developer/v1/videos/{id}/status",
			"POST /api/developer/v1/transcripts",
			"GET /api/developer/v1/usage",
		]) {
			expect(named(CAP_INFRA_AGENT_PROMPT)).toContain(call);
		}
		expect(CAP_INFRA_AGENT_PROMPT).toContain("every 2 seconds");
		expect(CAP_INFRA_AGENT_PROMPT).toContain("Retry-After");
		expect(CAP_INFRA_AGENT_PROMPT).toContain("60 requests a minute");
	});

	it("links only to the API reference", () => {
		const links = CAP_INFRA_AGENT_PROMPT.match(/https?:\/\/[^\s)]+/g) ?? [];
		expect([...new Set(links)].sort()).toEqual([
			"https://cap.so/docs/api/rest-api",
			"https://cap.so/openapi.json",
		]);
	});

	it("never asks for the Cap CLI, an MCP server or a pasted key", () => {
		expect(CAP_INFRA_AGENT_PROMPT).not.toMatch(/\bcap [a-z]/);
		expect(CAP_INFRA_AGENT_PROMPT).not.toMatch(/\bCLI\b|\bMCP\b|curl|install/i);
		expect(CAP_INFRA_AGENT_PROMPT).not.toContain("cpk_");
		expect(CAP_INFRA_AGENT_PROMPT).toContain(
			"Never ask me to paste the key into the chat",
		);
		expect(CAP_INFRA_AGENT_PROMPT).not.toContain("—");
	});

	it("opens with a line the console can show by itself", () => {
		const [opening] = CAP_INFRA_AGENT_PROMPT.split("\n");
		expect(opening).toBe(
			"Set up Cap Infra in this project so it can upload and play video.",
		);
	});

	it("is introduced in the console without the Cap CLI or an MCP server", () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"app/(infra)/dashboard/infra/_components/agent-setup.tsx",
			),
			"utf8",
		);
		expect(source).not.toMatch(/\bCLI\b|\bMCP\b/);
		expect(source).toContain("secret key");
	});
});
