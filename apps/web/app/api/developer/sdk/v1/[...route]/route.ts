import { Hono } from "hono";
import { handle } from "hono/vercel";
import { developerSdkCors } from "../../../../utils";
import * as upload from "./upload";
import * as videoCreate from "./video-create";

const app = new Hono()
	.basePath("/api/developer/sdk/v1")
	.use(developerSdkCors)
	.route("/videos", videoCreate.app)
	.route("/upload/multipart", upload.app);

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
