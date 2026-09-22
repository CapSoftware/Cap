import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "@effect/platform";
import { Layer } from "effect";
import { isMcpRedirectUri, mcpIssuer, registerMcpClient } from "@/lib/mcp-auth";
import { mcpApiToHandler, mcpRequest } from "@/lib/mcp-effect";
import { readMcpBody } from "@/lib/mcp-http";
import { isRateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";

async function register(request: Request) {
	if (
		request.headers.get("content-type")?.split(";")[0] !== "application/json"
	) {
		return Response.json({ error: "invalid_client_metadata" }, { status: 415 });
	}
	const body = await readMcpBody(request, 8_192);
	if (!body) {
		return Response.json({ error: "invalid_client_metadata" }, { status: 413 });
	}
	if (
		await isRateLimited("rl_mcp_client_registration", {
			headers: request.headers,
		})
	) {
		return Response.json({ error: "temporarily_unavailable" }, { status: 429 });
	}
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
	}
	const data = payload as Record<string, unknown>;
	const redirectUris = data.redirect_uris;
	const clientName =
		data.client_name === undefined ? "MCP client" : data.client_name;
	if (
		!Array.isArray(redirectUris) ||
		redirectUris.length < 1 ||
		redirectUris.length > 5 ||
		redirectUris.some(
			(uri) => typeof uri !== "string" || !isMcpRedirectUri(uri),
		) ||
		new Set(redirectUris).size !== redirectUris.length ||
		typeof clientName !== "string" ||
		clientName.trim().length < 1 ||
		clientName.length > 100 ||
		(data.token_endpoint_auth_method !== undefined &&
			data.token_endpoint_auth_method !== "none") ||
		(data.grant_types !== undefined &&
			(!Array.isArray(data.grant_types) ||
				data.grant_types.some(
					(grant) =>
						grant !== "authorization_code" && grant !== "refresh_token",
				))) ||
		(data.response_types !== undefined &&
			(!Array.isArray(data.response_types) ||
				data.response_types.some((type) => type !== "code")))
	) {
		return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
	}
	const clientId = await registerMcpClient({
		clientName: clientName.trim(),
		redirectUris,
	});
	if (!clientId)
		return Response.json(
			{ error: "temporarily_unavailable" },
			{ status: 429, headers: { "Cache-Control": "no-store" } },
		);
	return Response.json(
		{
			client_id: clientId,
			client_id_issued_at: Math.floor(Date.now() / 1_000),
			client_name: clientName.trim(),
			redirect_uris: redirectUris,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			issuer: mcpIssuer(),
		},
		{ status: 201, headers: { "Cache-Control": "no-store" } },
	);
}

class Api extends HttpApi.make("CapMcpRegistrationApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("register")`/api/mcp/oauth/register`,
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("register", () => mcpRequest(register)),
		),
	),
);

export const POST = mcpApiToHandler(ApiLive);
