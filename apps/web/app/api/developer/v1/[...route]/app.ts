import { Hono } from "hono";
import {
	developerApiError,
	developerApiNotFound,
	developerRateLimiter,
} from "../../../utils";

import * as transactions from "./transactions";
import * as transcripts from "./transcripts";
import * as uploads from "./uploads";
import * as usage from "./usage";
import * as videos from "./videos";

export const app = new Hono()
	.basePath("/api/developer/v1")
	.use(developerRateLimiter)
	.route("/videos", videos.app)
	.route("/uploads", uploads.app)
	.route("/transcripts", transcripts.app)
	.route("/usage", usage.app)
	.route("/transactions", transactions.app)
	.onError(developerApiError);

app.notFound((c) => developerApiNotFound(c, app.routes));
