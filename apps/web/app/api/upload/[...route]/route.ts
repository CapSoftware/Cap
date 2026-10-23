import { Hono } from "hono";
import { handle } from "hono/vercel";

import { corsMiddleware } from "../../utils";

import * as commentMedia from "./comment-media";
import * as multipart from "./multipart";
import * as recordingComplete from "./recording-complete";
import * as signed from "./signed";

const app = new Hono()
	.basePath("/api/upload")
	.use(corsMiddleware)
	.route("/comment-media", commentMedia.app)
	.route("/multipart", multipart.app)
	.route("/signed", signed.app)
	.route("/recording-complete", recordingComplete.app);

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
export const DELETE = handle(app);
