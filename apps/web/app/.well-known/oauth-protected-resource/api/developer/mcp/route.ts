import { apiErrorBody } from "@/lib/api-errors";

// The Cap Infra MCP server takes the app's secret key as a bearer token and
// has no OAuth, so it publishes no protected resource metadata. A document
// here would send OAuth clients to the authorization server of the library
// MCP server, whose tokens this server does not accept.
export function GET() {
	return Response.json(
		apiErrorBody(
			"oauth_not_supported",
			"The Cap Infra MCP server does not use OAuth",
			"Send the app's secret key (csk_) as Authorization: Bearer <key>. Setup: https://cap.so/docs/api/get-started#10-use-with-agents-mcp",
		),
		{ status: 404, headers: { "Cache-Control": "public, max-age=300" } },
	);
}
