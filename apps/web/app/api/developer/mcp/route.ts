import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "@effect/platform";
import { Layer } from "effect";
import { serveInfraMcp } from "@/lib/infra-mcp-endpoint";
import { mcpApiToHandler, mcpRequest } from "@/lib/mcp-effect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class Api extends HttpApi.make("CapInfraMcpApi").add(
	HttpApiGroup.make("root")
		.add(HttpApiEndpoint.post("post")`/api/developer/mcp`)
		.add(HttpApiEndpoint.get("get")`/api/developer/mcp`)
		.add(HttpApiEndpoint.del("delete")`/api/developer/mcp`),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("post", () => mcpRequest(serveInfraMcp))
				.handle("get", () => mcpRequest(serveInfraMcp))
				.handle("delete", () => mcpRequest(serveInfraMcp)),
		),
	),
);

const handler = mcpApiToHandler(ApiLive);

export const POST = handler;
export const GET = handler;
export const DELETE = handler;
