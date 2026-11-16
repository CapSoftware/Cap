import { infraMcpServerCardResponse } from "@/lib/agent-discovery";

export const GET = () =>
	infraMcpServerCardResponse("application/mcp-server-card+json");
