import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVELOPER_KEY_REQUESTS_PER_MINUTE } from "@/lib/developer-rate-limits";

const ORIGIN = "https://cap.test";
const ENDPOINT = `${ORIGIN}/api/developer/mcp`;

const state = vi.hoisted(() => ({
	keys: new Map<string, { appId: string; revoked: boolean }>(),
	gatedApps: new Set<string>(),
	rest: [] as Request[],
	nextKey: 0,
	presignFails: false,
	completeStatus: 200,
	completeBody: null as Record<string, unknown> | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const database = drizzle(async (query, params) => {
		if (query.includes("from `developer_api_keys`")) {
			const key = state.keys.get(String(params[0]).replace("hash:", ""));
			if (!key || key.revoked || params[1] !== "secret") return { rows: [] };
			return { rows: [[key.appId]] };
		}
		return { rows: [{ affectedRows: 1 }] };
	});
	return { db: () => database };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: ORIGIN },
	serverEnv: () => ({ WEB_URL: ORIGIN }),
}));
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	sharedRateLimitDecision: async () => undefined,
}));

const SIGNED_PART =
	"https://storage.test/developer/app1/video-1/video?partNumber=1&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeefsignature";

function appOf(request: Request) {
	const key = request.headers.get("authorization")?.split(" ")[1] ?? "";
	return state.keys.get(key)?.appId ?? null;
}

async function restAnswer(request: Request): Promise<Response> {
	state.rest.push(request);
	const url = new URL(request.url);
	const route = `${request.method} ${url.pathname}`;
	const appId = appOf(request);
	switch (route) {
		case "GET /api/developer/v1/usage":
			return Response.json({
				data: {
					balanceMicroCredits: 5_000_000,
					standing: { state: "active" },
					upload: { allowed: true },
				},
			});
		case "GET /api/developer/v1/videos":
			return Response.json({
				data: [{ id: "video-1", name: "Demo", status: "ready", duration: 12 }],
				total: 1,
			});
		case "POST /api/developer/v1/uploads":
			return Response.json({
				data: {
					id: "video-1",
					videoId: "video-1",
					token: "cut_uploadtoken123.signature",
					shareUrl: `${ORIGIN}/infra/s/video-1`,
					embedUrl: `${ORIGIN}/infra/e/video-1`,
				},
			});
		case "POST /api/developer/v1/uploads/video-1/token":
			return Response.json({
				data: { videoId: "video-1", token: "cut_renewedtoken123.signature" },
			});
		case "POST /api/developer/sdk/v1/upload/multipart/initiate":
			return Response.json({ uploadId: "upload-1" });
		case "POST /api/developer/sdk/v1/upload/multipart/presign-part":
			if (state.presignFails) {
				return Response.json(
					{ code: "storage_unavailable", message: "Storage failed" },
					{ status: 400 },
				);
			}
			return Response.json({
				parts: [{ partNumber: 1, presignedUrl: SIGNED_PART }],
			});
		case "POST /api/developer/sdk/v1/upload/multipart/complete":
			if (state.completeStatus !== 200) {
				return Response.json(
					state.completeBody ?? {
						code: "internal_error",
						message: "Something went wrong",
					},
					{ status: state.completeStatus },
				);
			}
			return Response.json({ success: true });
		case "GET /api/developer/v1/videos/video-1":
			return Response.json({
				data: { id: "video-1", status: "uploading", shareUrl: null },
			});
		case "POST /api/developer/sdk/v1/upload/multipart/abort":
			return Response.json({ success: true });
		case "POST /api/developer/v1/transcripts":
			if (appId !== null && state.gatedApps.has(appId)) {
				return Response.json(
					{
						code: "infra_not_available",
						message: "Cap Infra is not available for this account yet",
						hint: "Cap Infra is in preview. Contact hello@cap.so for access.",
					},
					{ status: 403 },
				);
			}
			return Response.json({
				data: { id: "transcript-1", status: "queued", name: "Talk" },
			});
		case "GET /api/developer/v1/transcripts/transcript-1":
			return Response.json({
				data: { id: "transcript-1", status: "complete", text: "Hello there" },
			});
		case "GET /api/developer/v1/videos/video-slow":
			return new Promise<Response>(() => {});
		default:
			return Response.json(
				{ code: "not_found", message: route },
				{ status: 404 },
			);
	}
}

vi.mock("@/app/api/developer/v1/[...route]/app", () => ({
	app: { fetch: restAnswer },
}));
vi.mock("@/app/api/developer/sdk/v1/[...route]/app", () => ({
	app: { fetch: restAnswer },
}));

type Route = typeof import("@/app/api/developer/mcp/route");
let route: Route;

beforeAll(async () => {
	route = await import("@/app/api/developer/mcp/route");
});

beforeEach(() => {
	state.rest.length = 0;
	state.gatedApps.clear();
	state.presignFails = false;
	state.completeStatus = 200;
	state.completeBody = null;
});

const newKey = (appId = "app1", revoked = false) => {
	const key = `csk_${appId}_unitsecret${++state.nextKey}`;
	state.keys.set(key, { appId, revoked });
	return key;
};

function mcp(
	credential: string | null,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return route.POST(
		new Request(ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"X-Forwarded-For": "203.0.113.7",
				...(credential ? { Authorization: `Bearer ${credential}` } : {}),
				...headers,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

async function rpc(
	credential: string,
	method: string,
	params: Record<string, unknown> = {},
) {
	const response = await mcp(credential, {
		jsonrpc: "2.0",
		id: 1,
		method,
		params,
	});
	expect(response.status).toBe(200);
	const text = await response.text();
	const line = text
		.split("\n")
		.find((entry) => entry.startsWith("data: ") && entry.includes('"id":1'));
	return {
		raw: text,
		message: JSON.parse(line ? line.slice(6) : text) as {
			result?: Record<string, unknown>;
			error?: unknown;
		},
	};
}

async function callTool(
	credential: string,
	name: string,
	args: Record<string, unknown> = {},
) {
	const { raw, message } = await rpc(credential, "tools/call", {
		name,
		arguments: args,
	});
	const result = message.result as {
		content: { text: string }[];
		isError?: boolean;
	};
	return {
		raw,
		isError: result.isError === true,
		body: JSON.parse(result.content[0]?.text ?? "null"),
	};
}

describe("hosted Cap Infra MCP auth", () => {
	const initialize = {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0.0" },
		},
	};

	it.each([
		["no Authorization header", null, "Invalid secret key"],
		["a public key", "cpk_app1_copied_from_a_page", "Invalid secret key"],
		["an upload token", "cut_uploadtoken123.signature", "Invalid secret key"],
		[
			"a secret key that does not exist",
			"csk_app1_neverissued",
			"Invalid or revoked secret key",
		],
	])("refuses %s like the REST API", async (_label, credential, message) => {
		const response = await mcp(credential, initialize);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("Bearer");
		expect(await response.json()).toMatchObject({
			code: "invalid_secret_key",
			message,
		});
		expect(state.rest).toHaveLength(0);
	});

	it("sends the REST API's response headers on refusals and answers", async () => {
		const refused = await mcp(null, initialize, {
			"x-vercel-id": "iad1::req-1",
		});
		expect(refused.status).toBe(401);
		expect(refused.headers.get("cache-control")).toBe("private, no-store");
		expect(refused.headers.get("x-request-id")).toBe("iad1::req-1");
		expect(refused.headers.get("www-authenticate")).toBe(
			'Bearer realm="cap-infra"',
		);

		const answered = await mcp(newKey(), initialize, {
			"x-vercel-id": "iad1::req-2",
		});
		expect(answered.status).toBe(200);
		expect(answered.headers.get("cache-control")).toBe("private, no-store");
		expect(answered.headers.get("x-request-id")).toBe("iad1::req-2");
		expect(answered.headers.get("www-authenticate")).toBeNull();
	});

	it("refuses a revoked secret key", async () => {
		const response = await mcp(newKey("app1", true), initialize);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			code: "invalid_secret_key",
			message: "Invalid or revoked secret key",
		});
	});

	it("passes the REST preview refusal through for an owner outside the preview", async () => {
		const key = newKey("gated");
		state.gatedApps.add("gated");
		const created = await callTool(key, "transcripts_create", {
			url: "https://example.com/talk.mp3",
		});
		expect(created.isError).toBe(true);
		expect(created.body.error).toMatchObject({
			code: "infra_not_available",
			status: 403,
		});
	});

	it("answers initialize for a valid secret key without touching REST", async () => {
		const response = await mcp(newKey(), initialize);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("cap-infra");
		expect(state.rest).toHaveLength(0);
	});
});

describe("hosted Cap Infra MCP tools", () => {
	it("lists the hosted tools with no local file access", async () => {
		const { message } = await rpc(newKey(), "tools/list");
		const tools = (
			message.result as {
				tools: {
					name: string;
					inputSchema: { properties: Record<string, { maximum?: number }> };
				}[];
			}
		).tools;
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"account_transactions",
			"account_usage",
			"transcripts_create",
			"transcripts_delete",
			"transcripts_get",
			"transcripts_list",
			"transcripts_text",
			"transcripts_wait",
			"videos_complete_upload",
			"videos_create_upload",
			"videos_delete",
			"videos_get",
			"videos_list",
			"videos_wait",
		]);
		const create = tools.find((tool) => tool.name === "transcripts_create");
		expect(Object.keys(create?.inputSchema.properties ?? {})).not.toContain(
			"path",
		);
		for (const name of ["videos_wait", "transcripts_wait"]) {
			const wait = tools.find((tool) => tool.name === name);
			expect(wait?.inputSchema.properties.timeoutSeconds?.maximum).toBe(45);
		}
	});

	it("reads usage and videos through the in-process REST API with the caller's key and address", async () => {
		const key = newKey();
		const usage = await callTool(key, "account_usage");
		expect(usage.isError).toBe(false);
		expect(usage.body).toMatchObject({ balanceMicroCredits: 5_000_000 });

		const videos = await callTool(key, "videos_list", { limit: 5 });
		expect(videos.body.videos).toEqual([
			expect.objectContaining({ id: "video-1", status: "ready" }),
		]);

		const [first, second] = state.rest;
		expect(new URL(first?.url ?? "").pathname).toBe("/api/developer/v1/usage");
		expect(first?.headers.get("authorization")).toBe(`Bearer ${key}`);
		expect(first?.headers.get("x-forwarded-for")).toBe("203.0.113.7");
		expect(new URL(second?.url ?? "").search).toBe("?limit=5&offset=0");
		expect(usage.raw).not.toContain(key);
	});

	it("creates an upload with signed part links and completes it", async () => {
		const key = newKey();
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const created = await callTool(key, "videos_create_upload", {
			contentLength: 1_000_000,
			fileName: "demo.mp4",
		});
		expect(created.isError).toBe(false);
		expect(created.body).toMatchObject({
			videoId: "video-1",
			uploadId: "upload-1",
			status: "uploading",
			parts: [{ partNumber: 1, bytes: 1_000_000, url: SIGNED_PART }],
			shareUrl: `${ORIGIN}/infra/s/video-1`,
		});
		expect(created.body.steps.join(" ")).toContain("videos_complete_upload");
		expect(created.raw).not.toContain("cut_");
		expect(created.raw).not.toContain(key);

		const initiate = state.rest.find((request) =>
			request.url.endsWith("/multipart/initiate"),
		);
		expect(initiate?.headers.get("authorization")).toBe(
			"Bearer cut_uploadtoken123.signature",
		);
		expect(await initiate?.json()).toEqual({
			videoId: "video-1",
			contentType: "video/mp4",
			contentLength: 1_000_000,
		});

		const completed = await callTool(key, "videos_complete_upload", {
			videoId: "video-1",
			uploadId: "upload-1",
			parts: [{ partNumber: 1, etag: '"etag-1"' }],
		});
		expect(completed.body).toMatchObject({
			videoId: "video-1",
			status: "processing",
		});
		const complete = state.rest.find((request) =>
			request.url.endsWith("/multipart/complete"),
		);
		expect(complete?.headers.get("authorization")).toBe(
			"Bearer cut_renewedtoken123.signature",
		);

		const logged = info.mock.calls.flat().join("\n");
		expect(logged).toContain("video_created");
		expect(logged).not.toContain(key);
		expect(logged).not.toContain("deadbeefsignature");
		expect(logged).not.toContain("cut_uploadtoken123");
		info.mockRestore();
	});

	it("creates a transcript from a url and reads its text", async () => {
		const key = newKey();
		const created = await callTool(key, "transcripts_create", {
			url: "https://example.com/talk.mp3",
		});
		expect(created.body).toMatchObject({ id: "transcript-1" });
		const sent = state.rest.at(-1);
		expect(sent?.method).toBe("POST");
		expect(await sent?.json()).toEqual({ url: "https://example.com/talk.mp3" });

		const text = await callTool(key, "transcripts_text", {
			transcriptId: "transcript-1",
		});
		expect(text.body).toEqual({
			id: "transcript-1",
			status: "complete",
			text: "Hello there",
		});
	});

	it("transcribes a stored video by id through the REST videoId field", async () => {
		const created = await callTool(newKey(), "transcripts_create", {
			videoId: "video-1",
		});
		expect(created.isError).toBe(false);
		expect(state.rest).toHaveLength(1);
		expect(await state.rest[0]?.json()).toEqual({ videoId: "video-1" });
	});

	it("aborts the upload it opened for a new video when signing fails", async () => {
		state.presignFails = true;
		const created = await callTool(newKey(), "videos_create_upload", {
			contentLength: 1_000_000,
		});
		expect(created.isError).toBe(true);
		expect(created.body).toMatchObject({
			videoId: "video-1",
			videoStatus: "uploading",
		});
		expect(
			state.rest.some((request) => request.url.endsWith("/multipart/abort")),
		).toBe(true);
	});

	it("keeps a reused upload and its stored parts when signing fails on retry", async () => {
		state.presignFails = true;
		const retried = await callTool(newKey(), "videos_create_upload", {
			contentLength: 1_000_000,
			videoId: "video-1",
		});
		expect(retried.isError).toBe(true);
		expect(
			state.rest.some((request) => request.url.endsWith("/multipart/abort")),
		).toBe(false);
	});

	it("says the outcome is unknown when completing fails on the server", async () => {
		state.completeStatus = 500;
		const completed = await callTool(newKey(), "videos_complete_upload", {
			videoId: "video-1",
			uploadId: "upload-1",
			parts: [{ partNumber: 1, etag: "etag-1" }],
		});
		expect(completed.isError).toBe(true);
		expect(completed.body).toMatchObject({
			videoId: "video-1",
			videoStatus: "unknown",
			next: expect.stringContaining("videos_get"),
		});
	});

	it("tells the caller to upload again when completing removed the file", async () => {
		state.completeStatus = 402;
		state.completeBody = {
			code: "insufficient_credits",
			message: "Not enough credit to store this video",
			fileRemoved: true,
		};
		const completed = await callTool(newKey(), "videos_complete_upload", {
			videoId: "video-1",
			uploadId: "upload-1",
			parts: [{ partNumber: 1, etag: "etag-1" }],
		});
		expect(completed.isError).toBe(true);
		expect(completed.body.error).toMatchObject({ fileRemoved: true });
		expect(completed.body.next).toContain("upload the file again");
		expect(completed.body.next).not.toContain("parts are kept");
	});

	it("refuses a local path for a transcript", async () => {
		const result = await callTool(newKey(), "transcripts_create", {
			path: "/etc/passwd",
		});
		expect(result.isError).toBe(true);
		expect(result.body.error.code).toBe("invalid_source");
		expect(state.rest).toHaveLength(0);
	});
});

describe("hosted Cap Infra MCP limits", () => {
	it("refuses a body over 64 KB before any MCP work", async () => {
		const response = await mcp(newKey(), {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "videos_list",
				arguments: { userId: "x".repeat(70_000) },
			},
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ code: "request_too_large" });
		expect(state.rest).toHaveLength(0);
	});

	it("refuses a body that is not JSON", async () => {
		const response = await mcp(newKey(), "hello", {
			"Content-Type": "text/plain",
		});
		expect(response.status).toBe(415);
	});

	it("answers GET with 405 since the endpoint holds no sessions", async () => {
		const response = await route.GET(
			new Request(ENDPOINT, {
				headers: { Authorization: `Bearer ${newKey()}` },
			}),
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	it("applies the REST API's per-key limit to MCP requests", async () => {
		const key = newKey();
		const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
		for (let index = 0; index < DEVELOPER_KEY_REQUESTS_PER_MINUTE; index++) {
			expect((await mcp(key, list)).status).toBe(200);
		}
		const limited = await mcp(key, list);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).not.toBeNull();
		expect(await limited.json()).toMatchObject({ code: "rate_limited" });
		expect((await mcp(newKey(), list)).status).toBe(200);
	});

	it("stops a tool that outlives its budget and says so", async () => {
		const { inProcessDeveloperFetch } = await import("@/lib/infra-mcp-rest");
		const { createHostedTools } = await import("@cap/infra-mcp/hosted");
		const tools = createHostedTools({
			apiUrl: ORIGIN,
			secretKey: newKey(),
			fetch: inProcessDeveloperFetch(new Headers()),
			log: () => {},
			budgetMs: 200,
		});
		const get = tools.find((tool) => tool.name === "videos_get");
		const startedAt = Date.now();
		const result = await get?.run(
			{ videoId: "video-slow" },
			{
				signal: new AbortController().signal,
				progressToken: undefined,
				sendProgress: async () => {},
				sendLog: async () => {},
			},
		);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(result?.isError).toBe(true);
		expect(JSON.parse(result?.content[0]?.text ?? "{}").error).toMatchObject({
			code: "timeout",
		});
	});
});
