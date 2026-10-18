import "server-only";

import { AgentHttpAuthMiddlewareLive, AgentManagement } from "@cap/web-backend";
import type { Agent } from "@cap/web-domain";
import { Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import { allowedOrigins } from "@/utils/cors";
import { Dependencies } from "./server";

const cors = HttpRouter.cors({
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

export const agentApiToHandler = <R>(
	api: Layer.Layer<never, never, R | Agent.AgentHttpAuthMiddleware>,
) => {
	const routes = Layer.mergeAll(api, cors).pipe(
		Layer.provide(AgentHttpAuthMiddlewareLive),
		Layer.provide(AgentManagement.Default),
		Layer.provide(Dependencies),
		Layer.provide(HttpServer.layerServices),
		Layer.provide(
			Layer.succeed(
				HttpMiddleware.SpanNameGenerator,
				(req) => `${req.method} ${req.url}`,
			),
		),
	);
	const { handler } = HttpRouter.toWebHandler(routes);
	return (req: Request) => handler(req);
};
