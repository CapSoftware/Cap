import { mcpIssuer, mcpResource } from "@/lib/mcp-auth";

export const runtime = "nodejs";

export function GET() {
	return Response.json(
		{
			resource: mcpResource(),
			authorization_servers: [mcpIssuer()],
			scopes_supported: ["caps:read"],
			bearer_methods_supported: ["header"],
		},
		{ headers: { "Cache-Control": "public, max-age=300" } },
	);
}
