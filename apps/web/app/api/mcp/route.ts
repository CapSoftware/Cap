import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "@effect/platform";
import { Layer } from "effect";
import {
	authenticateMcpBearer,
	mcpIssuer,
	mcpProtectedResourceMetadataUrl,
	mcpResource,
} from "@/lib/mcp-auth";
import { mcpApiToHandler, mcpRequest } from "@/lib/mcp-effect";
import { readMcpBody } from "@/lib/mcp-http";
import { capMcpHandler } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedOrigins = () =>
	new Set([
		mcpIssuer(),
		"https://chatgpt.com",
		"https://claude.ai",
		"https://muse.ai",
	]);

const corsHeaders = (request: Request) => {
	const origin = request.headers.get("origin");
	if (!origin || !allowedOrigins().has(origin)) return new Headers();
	return new Headers({
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
		"Access-Control-Expose-Headers":
			"Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate",
		Vary: "Origin",
	});
};

const respond = (request: Request, response: Response) => {
	const headers = new Headers(response.headers);
	for (const [key, value] of corsHeaders(request)) headers.set(key, value);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, { status: response.status, headers });
};

const challenge = (request: Request) =>
	respond(
		request,
		Response.json(
			{ error: "invalid_token" },
			{
				status: 401,
				headers: {
					"WWW-Authenticate": `Bearer resource_metadata="${mcpProtectedResourceMetadataUrl()}", scope="caps:read"`,
				},
			},
		),
	);

async function handleOptions(request: Request) {
	const origin = request.headers.get("origin");
	if (origin && !allowedOrigins().has(origin))
		return new Response(null, { status: 403 });
	return respond(request, new Response(null, { status: 204 }));
}

async function handlePost(request: Request) {
	const origin = request.headers.get("origin");
	if (origin && !allowedOrigins().has(origin))
		return new Response(null, { status: 403 });
	if (new URL(request.url).origin !== mcpIssuer())
		return new Response(null, { status: 421 });
	const authorization = request.headers.get("authorization");
	const principal = await authenticateMcpBearer(authorization);
	if (!principal) return challenge(request);
	if (
		request.headers.get("content-type")?.split(";")[0] !== "application/json"
	) {
		return respond(
			request,
			new Response("Expected application/json", { status: 415 }),
		);
	}
	const body = await readMcpBody(request, 32_768);
	if (!body)
		return respond(
			request,
			new Response("Request body too large", { status: 413 }),
		);
	const token = authorization?.split(" ")[1];
	if (!token) return challenge(request);
	const forwarded = new Request(request.url, {
		method: "POST",
		headers: request.headers,
		body,
	});
	const response = await capMcpHandler.fetch(forwarded, {
		authInfo: {
			token,
			clientId: principal.clientId,
			scopes: ["caps:read"],
			resource: new URL(mcpResource()),
			extra: { userId: principal.userId },
		},
	});
	return respond(request, response);
}

async function handleGet(request: Request) {
	const origin = request.headers.get("origin");
	if (origin && !allowedOrigins().has(origin))
		return new Response(null, { status: 403 });
	const principal = await authenticateMcpBearer(
		request.headers.get("authorization"),
	);
	if (!principal) return challenge(request);
	return respond(
		request,
		new Response("Stateless MCP endpoint", { status: 405 }),
	);
}

class Api extends HttpApi.make("CapMcpTransportApi").add(
	HttpApiGroup.make("root")
		.add(HttpApiEndpoint.options("options")`/api/mcp`)
		.add(HttpApiEndpoint.post("post")`/api/mcp`)
		.add(HttpApiEndpoint.get("get")`/api/mcp`),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("options", () => mcpRequest(handleOptions))
				.handle("post", () => mcpRequest(handlePost))
				.handle("get", () => mcpRequest(handleGet)),
		),
	),
);

const handler = mcpApiToHandler(ApiLive);

export const OPTIONS = handler;
export const POST = handler;
export const GET = handler;
