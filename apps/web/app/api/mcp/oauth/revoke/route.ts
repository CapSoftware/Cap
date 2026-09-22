import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "@effect/platform";
import { Layer } from "effect";
import { revokeMcpToken } from "@/lib/mcp-auth";
import { mcpApiToHandler, mcpRequest } from "@/lib/mcp-effect";
import { readMcpBody } from "@/lib/mcp-http";

export const runtime = "nodejs";

async function revoke(request: Request) {
	if (
		request.headers.get("content-type")?.split(";")[0] !==
		"application/x-www-form-urlencoded"
	) {
		return Response.json({ error: "invalid_request" }, { status: 415 });
	}
	const body = await readMcpBody(request, 8_192);
	if (!body) {
		return Response.json({ error: "invalid_request" }, { status: 413 });
	}
	const params = new URLSearchParams(new TextDecoder().decode(body));
	const token = params.get("token");
	const clientId = params.get("client_id");
	if (!token || !clientId || token.length > 128 || clientId.length > 128) {
		return Response.json({ error: "invalid_request" }, { status: 400 });
	}
	await revokeMcpToken(token, clientId);
	return new Response(null, {
		status: 200,
		headers: { "Cache-Control": "no-store" },
	});
}

class Api extends HttpApi.make("CapMcpRevocationApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("revoke")`/api/mcp/oauth/revoke`,
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("revoke", () => mcpRequest(revoke)),
		),
	),
);

export const POST = mcpApiToHandler(ApiLive);
