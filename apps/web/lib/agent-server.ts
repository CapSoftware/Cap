import "server-only";

import { AgentHttpAuthMiddlewareLive, AgentManagement } from "@cap/web-backend";
import type { Agent } from "@cap/web-domain";
import {
	type HttpApi,
	HttpApiBuilder,
	HttpMiddleware,
	HttpServer,
} from "@effect/platform";
import { Layer } from "effect";
import { allowedOrigins } from "@/utils/cors";
import { Dependencies } from "./server";
import { layerTracer } from "./tracing";

const cors = HttpApiBuilder.middlewareCors({
	allowedOrigins,
	credentials: false,
	allowedMethods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
	allowedHeaders: [
		"Content-Type",
		"Authorization",
		"Idempotency-Key",
		"X-Cap-Access-Grant",
		"X-Cap-Confirmation",
		"sentry-trace",
		"baggage",
	],
});

export const agentApiToHandler = (
	api: Layer.Layer<
		HttpApi.Api,
		never,
		| Layer.Layer.Success<typeof Dependencies>
		| Agent.AgentHttpAuthMiddleware
		| AgentManagement
	>,
) =>
	api.pipe(
		HttpMiddleware.withSpanNameGenerator((req) => `${req.method} ${req.url}`),
		Layer.provideMerge(AgentHttpAuthMiddlewareLive),
		Layer.provideMerge(AgentManagement.Default),
		Layer.merge(HttpServer.layerContext),
		Layer.provide(cors),
		Layer.provide(layerTracer),
		Layer.provideMerge(Dependencies),
		HttpApiBuilder.toWebHandler,
		(v) => (req: Request) => v.handler(req),
	);
