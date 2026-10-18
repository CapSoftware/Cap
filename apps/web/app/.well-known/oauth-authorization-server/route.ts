import { mcpIssuer } from "@/lib/mcp-auth";

export const runtime = "nodejs";

export function GET() {
	const issuer = mcpIssuer();
	return Response.json(
		{
			issuer,
			authorization_endpoint: `${issuer}/mcp/authorize`,
			token_endpoint: `${issuer}/api/mcp/oauth/token`,
			registration_endpoint: `${issuer}/api/mcp/oauth/register`,
			revocation_endpoint: `${issuer}/api/mcp/oauth/revoke`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			revocation_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["caps:read"],
			authorization_response_iss_parameter_supported: true,
		},
		{ headers: { "Cache-Control": "public, max-age=300" } },
	);
}
