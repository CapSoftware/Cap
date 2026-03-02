import { Hono } from "hono";
import { handle } from "hono/vercel";

import * as usage from "./usage";
import * as videos from "./videos";

const app = new Hono()
	.basePath("/api/developer/v1")
	.route("/videos", videos.app)
	.route("/usage", usage.app);

export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
