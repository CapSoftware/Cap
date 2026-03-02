import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { handle } from "hono/vercel";
import { developerSdkCors } from "../../../../utils";
import * as upload from "./upload";
import * as videoCreate from "./video-create";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

const requestCounts = new Map<string, { count: number; resetAt: number }>();

const rateLimiter = createMiddleware(async (c, next) => {
	const key =
		c.req.header("authorization")?.slice(0, 20) ??
		c.req.header("x-forwarded-for") ??
		"unknown";
	const now = Date.now();
	const entry = requestCounts.get(key);

	if (!entry || now > entry.resetAt) {
		requestCounts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
	} else {
		entry.count++;
		if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
			return c.json({ error: "Rate limit exceeded" }, 429);
		}
	}

	await next();
});

const app = new Hono()
	.basePath("/api/developer/sdk/v1")
	.use(developerSdkCors)
	.use(rateLimiter)
	.route("/videos", videoCreate.app)
	.route("/upload/multipart", upload.app);

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
