import { Hono } from "hono";
import { handle } from "hono/vercel";

import { corsMiddleware, withAuth } from "../../utils";

import * as multipart from "./multipart";
import * as signed from "./signed";

const app = new Hono()
	.basePath("/api/upload")
	.use(corsMiddleware)
	.route("/multipart", multipart.app)
	.route("/signed", signed.app);

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
export const DELETE = handle(app);
