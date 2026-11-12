import { Hono } from "hono";
import { handle } from "hono/vercel";
import {
	developerApiError,
	developerApiNotFound,
	developerSdkCors,
	developerUploadRateLimiter,
	refuseDeveloperPublicKey,
} from "../../../../utils";
import * as upload from "./upload";

const app = new Hono()
	.basePath("/api/developer/sdk/v1")
	.use(developerSdkCors)
	.use(developerUploadRateLimiter)
	.use(refuseDeveloperPublicKey)
	.route("/upload/multipart", upload.app)
	.onError(developerApiError);

app.notFound((c) => developerApiNotFound(c, app.routes));

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
