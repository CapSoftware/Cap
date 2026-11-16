import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));
vi.mock("@/lib/mcp-auth", () => ({
	authenticateMcpBearer: async (authorization: string | null) =>
		authorization === "Bearer valid"
			? { userId: "owner", clientId: "client" }
			: null,
	mcpIssuer: () => "https://cap.so",
	mcpResource: () => "https://cap.so/api/mcp",
	mcpProtectedResourceMetadataUrl: () =>
		"https://cap.so/.well-known/oauth-protected-resource/api/mcp",
}));
vi.mock("@/lib/mcp-data", () => ({
	listMcpCaps: async () => ({ caps: [], nextCursor: null }),
	getMcpCap: async () => null,
	getMcpCapContext: async () => null,
}));

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

describe("regular Cap MCP is unchanged by the Infra MCP", () => {
	it("lists the same tools and serves the same server card", async () => {
		const { POST } = await import("@/app/api/mcp/route");
		const { GET } = await import("@/app/.well-known/mcp/route");
		const listed = await POST(
			new Request("https://cap.so/api/mcp", {
				method: "POST",
				headers: {
					Authorization: "Bearer valid",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				}),
			}),
		);
		const data = (await listed.text())
			.split("\n")
			.find((line) => line.startsWith("data: "));
		const tools = JSON.stringify(JSON.parse(data?.slice(6) ?? "").result.tools);
		const card = await (await GET()).text();
		expect(sha256(tools)).toBe(
			"3777d45b0877cb63f1899bc0fde71996aac5dee16bf295e09637e49e6ab6dca3",
		);
		expect(sha256(card)).toBe(
			"5fa2dde2ab13f218a289a3f0eabdb3596cd57114b314fcfcefba632fa139426d",
		);
	});
});
