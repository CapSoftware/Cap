import { exchangeMcpCode, refreshMcpTokens } from "@/lib/mcp-auth";
import { readMcpBody } from "@/lib/mcp-http";
import { isRateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
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
	if (
		await isRateLimited("rl_agent_token_exchange", { headers: request.headers })
	) {
		return Response.json({ error: "temporarily_unavailable" }, { status: 429 });
	}
	const params = new URLSearchParams(new TextDecoder().decode(body));
	const grantType = params.get("grant_type");
	const result =
		grantType === "authorization_code"
			? await exchangeMcpCode(params)
			: grantType === "refresh_token"
				? await refreshMcpTokens(params)
				: null;
	if (!result) {
		return Response.json(
			{
				error:
					grantType === "authorization_code" || grantType === "refresh_token"
						? "invalid_grant"
						: "unsupported_grant_type",
			},
			{ status: 400, headers: { "Cache-Control": "no-store" } },
		);
	}
	return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
