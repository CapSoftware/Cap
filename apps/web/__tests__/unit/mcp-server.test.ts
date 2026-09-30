import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
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
	listMcpCaps: async () => ({
		caps: [{ id: "video-1", title: "Demo" }],
		nextCursor: null,
	}),
	getMcpCap: async (_userId: string, id: string) =>
		id === "video-1"
			? { id, title: "Demo", url: "https://cap.so/s/video-1" }
			: null,
	getMcpCapContext: async () => ({
		id: "video-1",
		title: "Demo",
		url: "https://cap.so/s/video-1",
		summary: "A recording",
		transcriptStatus: "available",
		cues: [
			{
				startMs: 1_000,
				endMs: 2_000,
				text: "Hello",
				url: "https://cap.so/s/video-1?t=1",
			},
		],
		hasMoreCues: false,
	}),
}));

describe("hosted MCP transport", () => {
	let POST: typeof import("@/app/api/mcp/route").POST;
	let GET: typeof import("@/app/api/mcp/route").GET;
	let OPTIONS: typeof import("@/app/api/mcp/route").OPTIONS;

	beforeAll(async () => {
		const route = await import("@/app/api/mcp/route");
		POST = route.POST;
		GET = route.GET;
		OPTIONS = route.OPTIONS;
	});

	const request = (body: Record<string, unknown>, token = "valid") =>
		new Request("https://cap.so/api/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
		});

	it("challenges unauthenticated requests with protected resource metadata", async () => {
		const response = await POST(
			request({ jsonrpc: "2.0", id: 1, method: "initialize" }, "invalid"),
		);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(
			"oauth-protected-resource/api/mcp",
		);
		expect((await GET(new Request("https://cap.so/api/mcp"))).status).toBe(401);
	});

	it("rejects an unapproved browser origin", async () => {
		const response = await OPTIONS(
			new Request("https://cap.so/api/mcp", {
				method: "OPTIONS",
				headers: { Origin: "https://attacker.example" },
			}),
		);
		expect(response.status).toBe(403);
	});

	it("preserves browser preflight and OAuth challenge headers", async () => {
		const origin = "https://chatgpt.com";
		const preflight = await OPTIONS(
			new Request("https://cap.so/api/mcp", {
				method: "OPTIONS",
				headers: { Origin: origin },
			}),
		);
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
		expect(preflight.headers.get("cache-control")).toBe("no-store");
		const unauthorized = await POST(
			new Request("https://cap.so/api/mcp", {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: "{}",
			}),
		);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("access-control-allow-origin")).toBe(
			origin,
		);
		expect(unauthorized.headers.get("www-authenticate")).toContain(
			"resource_metadata",
		);
	});

	it("keeps host, origin, media type, and body limits ahead of MCP dispatch", async () => {
		const payload = { jsonrpc: "2.0", id: 1, method: "initialize" };
		const blockedOrigin = request(payload);
		blockedOrigin.headers.set("Origin", "https://attacker.example");
		expect((await POST(blockedOrigin)).status).toBe(403);
		const wrongHost = new Request("https://elsewhere.example/api/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer valid" },
			body: JSON.stringify(payload),
		});
		expect((await POST(wrongHost)).status).toBe(421);
		const wrongMediaType = request(payload);
		wrongMediaType.headers.set("Content-Type", "text/plain");
		expect((await POST(wrongMediaType)).status).toBe(415);
		const oversized = request(payload);
		oversized.headers.set("Content-Length", "32769");
		expect((await POST(oversized)).status).toBe(413);
	});

	it("initializes, lists three read-only tools, and reads a recording", async () => {
		const initialized = await POST(
			request({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
		);
		expect(initialized.status).toBe(200);
		const listed = await POST(
			request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		);
		expect(listed.status).toBe(200);
		const listBody = await listed.text();
		expect(listBody).toContain("caps_list");
		expect(listBody).toContain("caps_get");
		expect(listBody).toContain("caps_context");
		expect(listBody).not.toContain("caps_delete");
		const called = await POST(
			request({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "caps_context", arguments: { id: "video-1" } },
			}),
		);
		expect(called.status).toBe(200);
		expect(await called.text()).toContain("A recording");
	});

	it("serves modern per-request tool and app resource calls", async () => {
		const meta = {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
			"io.modelcontextprotocol/clientCapabilities": {},
		};
		const modern = (
			method: string,
			params: Record<string, unknown>,
			name?: string,
		) =>
			new Request("https://cap.so/api/mcp", {
				method: "POST",
				headers: {
					Authorization: "Bearer valid",
					"Content-Type": "application/json",
					"MCP-Protocol-Version": "2026-07-28",
					"Mcp-Method": method,
					...(name ? { "Mcp-Name": name } : {}),
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 4,
					method,
					params: { ...params, _meta: meta },
				}),
			});
		const listed = await POST(modern("tools/list", {}));
		expect(listed.status).toBe(200);
		expect(await listed.text()).toContain("caps_context");
		const resource = await POST(
			modern(
				"resources/read",
				{
					uri: "ui://cap/recording-card.html",
				},
				"ui://cap/recording-card.html",
			),
		);
		expect(resource.status).toBe(200);
		expect(await resource.text()).toContain("text/html;profile=mcp-app");
		const mismatchRequest = modern("tools/list", {});
		mismatchRequest.headers.set("Mcp-Method", "tools/call");
		const mismatched = await POST(mismatchRequest);
		expect(mismatched.status).toBe(400);
	});
});
