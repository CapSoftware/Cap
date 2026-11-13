import { Hono } from "hono";
import {
	developerApiError,
	developerApiNotFound,
	developerSdkCors,
	developerUploadRateLimiter,
	refuseDeveloperPublicKey,
} from "../../../../utils";
import * as upload from "./upload";

export const app = new Hono()
	.basePath("/api/developer/sdk/v1")
	.use(developerSdkCors)
	.use(developerUploadRateLimiter)
	.use(refuseDeveloperPublicKey)
	.route("/upload/multipart", upload.app)
	.onError(developerApiError);

app.notFound((c) => developerApiNotFound(c, app.routes));
