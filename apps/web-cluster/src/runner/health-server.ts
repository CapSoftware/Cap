import { createServer } from "node:http";
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";

// Define the router with a single route for the root URL
const router = HttpRouter.empty.pipe(
	HttpRouter.get("/health", HttpServerResponse.text("ok")),
);

// Set up the application server
const app = router.pipe(HttpServer.serve());

// Specify the port
const port = process.env.HEALTH_CHECK_PORT
	? parseInt(process.env.HEALTH_CHECK_PORT, 10)
	: 3000;

// Create a server layer with the specified port
const ServerLive = NodeHttpServer.layer(() => createServer(), { port });

export const HealthServerLive = Layer.provide(app, ServerLive);
