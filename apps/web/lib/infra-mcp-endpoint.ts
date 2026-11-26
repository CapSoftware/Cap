import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
	developerApiError,
	developerApiNotFound,
	developerRateLimiter,
	developerResponseHeaders,
	withDeveloperSecretAuth,
} from "@/app/api/utils";
import { apiErrorBody } from "@/lib/api-errors";
import { DEVELOPER_RATE_LIMIT_WINDOW_SECONDS } from "@/lib/developer-rate-limits";
import {
	INFRA_MCP_MAX_BODY_BYTES,
	INFRA_MCP_PATH,
	infraMcpHandler,
} from "@/lib/infra-mcp-server";
import { readMcpBody } from "@/lib/mcp-http";

export const INFRA_MCP_SETUP_DOCS =
	"https://cap.so/docs/api/get-started#10-use-with-agents-mcp";

const asObject = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const replaceBody = (c: Context, body: unknown, status: number) => {
	c.res = new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
};

const PUBLIC_KEY_MESSAGE = "Public keys cannot call this MCP server";

// The key checks are shared with REST, so their refusals name the REST API and
// link its reference. Here they name this server and link its setup instead.
const mcpAuthWording = createMiddleware(async (c, next) => {
	await next();
	const { status } = c.res;
	if (status !== 401 && status !== 403) return;
	const body = asObject(
		await c.res
			.clone()
			.json()
			.catch(() => null),
	);
	if (
		body?.code !== "invalid_secret_key" &&
		body?.code !== "public_key_not_allowed"
	) {
		return;
	}
	const emptyBearer = /^bearer$/i.test(
		c.req.header("authorization")?.trim() ?? "",
	);
	replaceBody(
		c,
		{
			...body,
			...(body.code === "public_key_not_allowed"
				? {
						error: PUBLIC_KEY_MESSAGE,
						message: PUBLIC_KEY_MESSAGE,
						hint: "A public key (cpk_) was sent. This MCP server takes the app's secret key: send Authorization: Bearer csk_... with the secret key from https://cap.so/dashboard/infra.",
					}
				: {}),
			...(emptyBearer
				? {
						hint: "The Authorization header has no key after Bearer. Export CAP_SECRET_KEY in the shell that starts your MCP client, or check the key in its config.",
					}
				: {}),
			docs: INFRA_MCP_SETUP_DOCS,
		},
		status,
	);
});

async function toolCallId(request: Request) {
	const body = await readMcpBody(request, INFRA_MCP_MAX_BODY_BYTES).catch(
		() => null,
	);
	if (!body) return null;
	let message: Record<string, unknown> | null;
	try {
		message = asObject(JSON.parse(new TextDecoder().decode(body)));
	} catch {
		return null;
	}
	const id = message?.id;
	return message?.method === "tools/call" &&
		(typeof id === "string" || typeof id === "number")
		? id
		: null;
}

// A model never sees HTTP headers, so a 429 to a tool call leaves it with no
// wait time, and some clients treat it as the server failing. The limiter has
// already counted and refused the request; this only changes how a refused
// tools/call is worded. Every other method keeps its 429.
const rateLimitedToolCall = createMiddleware<{
	Variables: { developerAppId?: string };
}>(async (c, next) => {
	await next();
	if (c.res.status !== 429 || !c.get("developerAppId")) return;
	const refusal = asObject(
		await c.res
			.clone()
			.json()
			.catch(() => null),
	);
	if (refusal?.code !== "rate_limited") return;
	const id = await toolCallId(c.req.raw);
	if (id === null) return;
	const retryAfterSeconds =
		Number(c.res.headers.get("retry-after")) ||
		DEVELOPER_RATE_LIMIT_WINDOW_SECONDS;
	const limit = String(refusal.hint ?? "").replace(
		/^Wait for the Retry-After seconds, then retry\.\s*/,
		"",
	);
	const error = {
		code: "rate_limited",
		message: String(refusal.message ?? "Rate limit exceeded"),
		hint: `Wait ${retryAfterSeconds} seconds, then call the tool again.${limit ? ` ${limit}` : ""}`,
		status: 429,
		retryAfterSeconds,
	};
	replaceBody(
		c,
		{
			jsonrpc: "2.0",
			id,
			result: {
				content: [{ type: "text", text: JSON.stringify({ error }) }],
				isError: true,
			},
		},
		200,
	);
});

const app = new Hono<{
	Variables: { developerAppId: string; developerKeyType: "secret" };
}>()
	.basePath(INFRA_MCP_PATH)
	.use(developerResponseHeaders)
	.use(async (c, next) => {
		await next();
		if (c.res.status === 401) {
			c.header("WWW-Authenticate", 'Bearer realm="cap-infra"');
		}
	})
	.use(mcpAuthWording)
	.use(rateLimitedToolCall)
	.use(developerRateLimiter)
	.use(withDeveloperSecretAuth)
	.post("/", async (c) => {
		const contentType = c.req.header("content-type")?.split(";")[0]?.trim();
		if (contentType !== "application/json") {
			return c.json(
				apiErrorBody(
					"unsupported_media_type",
					"Send MCP messages as application/json",
					"Use an MCP client with the Streamable HTTP transport.",
				),
				415,
			);
		}
		const body = await readMcpBody(c.req.raw, INFRA_MCP_MAX_BODY_BYTES);
		if (!body) {
			return c.json(
				apiErrorBody(
					"request_too_large",
					`The request body is larger than ${INFRA_MCP_MAX_BODY_BYTES} bytes`,
					"Send smaller tool arguments.",
				),
				413,
			);
		}
		const secretKey = c.req.header("authorization")?.split(" ")[1] ?? "";
		return infraMcpHandler.fetch(
			new Request(c.req.url, {
				method: "POST",
				headers: c.req.raw.headers,
				body,
			}),
			{
				authInfo: {
					token: secretKey,
					clientId: c.get("developerAppId"),
					scopes: [],
				},
			},
		);
	})
	.onError(developerApiError);

app.notFound((c) => developerApiNotFound(c, app.routes));

export const serveInfraMcp = (request: Request) =>
	Promise.resolve(app.fetch(request));
