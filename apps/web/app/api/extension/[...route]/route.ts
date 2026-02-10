import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/vercel";

import * as me from "./me";
import * as session from "./session";

const app = new Hono()
	.basePath("/api/extension")
	.use(
		cors({
			origin: "*",
			credentials: false,
			allowMethods: ["GET", "OPTIONS"],
			allowHeaders: [
				"Content-Type",
				"Authorization",
				"sentry-trace",
				"baggage",
			],
		}),
	)
	.route("/session", session.app)
	.route("/me", me.app);

export const GET = handle(app);
export const OPTIONS = handle(app);
