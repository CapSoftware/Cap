import { mcpServerCardResponse } from "@/lib/agent-discovery";

export const GET = () =>
	mcpServerCardResponse("application/mcp-server-card+json");
