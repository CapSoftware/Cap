import { Hono } from "hono";
import { handle } from "hono/vercel";
import { apiErrorBody } from "@/lib/api-errors";
import {
	INFRA_MCP_MAX_BODY_BYTES,
	INFRA_MCP_PATH,
	infraMcpHandler,
} from "@/lib/infra-mcp-server";
import { readMcpBody } from "@/lib/mcp-http";
import {
	developerApiError,
	developerApiNotFound,
	developerRateLimiter,
	withDeveloperSecretAuth,
} from "../../utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const app = new Hono<{
	Variables: { developerAppId: string; developerKeyType: "secret" };
}>()
	.basePath(INFRA_MCP_PATH)
	.use(async (c, next) => {
		await next();
		c.header("Cache-Control", "no-store");
		if (c.res.status === 401) {
			c.header("WWW-Authenticate", 'Bearer realm="cap-infra"');
		}
	})
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

export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
