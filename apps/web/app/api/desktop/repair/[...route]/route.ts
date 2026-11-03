import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";
import { corsMiddleware, withAuth } from "@/app/api/utils";
import { isRateLimited } from "@/lib/rate-limit";
import {
	createRepairSession,
	RepairBusyError,
	repairSettings,
	resolveRepairModel,
	stopRepairSession,
} from "@/lib/recording-repair/sandbox";
import {
	completeSubmission,
	createSubmission,
	isSubmissionId,
	presignParts,
	submissionRequestSchema,
} from "@/lib/recording-repair/submissions";

export const maxDuration = 300;

const app = new Hono().basePath("/api/desktop/repair").use(corsMiddleware);

app.get("/config", (c) => {
	const { enabled, submissions } = repairSettings();
	c.header("Cache-Control", "public, max-age=60");
	return c.json({ enabled, submissions });
});

const authed = app.use(withAuth);

authed.post(
	"/sessions",
	zValidator(
		"json",
		z.object({
			operation: z.enum(["recover", "open"]),
			appVersion: z.string().max(64),
			os: z.enum(["macos", "windows", "linux"]),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { operation, appVersion } = c.req.valid("json");
		const model = resolveRepairModel();
		if (!model || !repairSettings().enabled)
			return c.json({ error: "unavailable" }, 503);
		if (
			await isRateLimited("desktop-recording-repair", {
				key: user.id,
				headers: c.req.raw.headers,
			})
		)
			return c.json({ error: "rate_limited" }, 429);
		try {
			return c.json(
				await createRepairSession({
					userId: user.id,
					operation,
					appVersion,
					model,
				}),
			);
		} catch (error) {
			if (error instanceof RepairBusyError)
				return c.json({ error: "rate_limited" }, 429);
			console.error("[recording-repair] session setup failed", error);
			return c.json({ error: "unavailable" }, 503);
		}
	},
);

authed.post("/sessions/:sessionId/stop", async (c) => {
	await stopRepairSession({
		userId: c.get("user").id,
		sessionId: c.req.param("sessionId"),
	}).catch((error) => console.error("[recording-repair] stop failed", error));
	return c.json({ ok: true });
});

authed.post(
	"/submissions",
	zValidator("json", submissionRequestSchema),
	async (c) => {
		const user = c.get("user");
		if (!repairSettings().submissions)
			return c.json({ error: "unavailable" }, 503);
		if (
			await isRateLimited("desktop-recording-repair-submission", {
				key: user.id,
				headers: c.req.raw.headers,
			})
		)
			return c.json({ error: "rate_limited" }, 429);
		try {
			return c.json(await createSubmission(user.id, c.req.valid("json")));
		} catch (error) {
			console.error("[recording-repair] submission create failed", error);
			return c.json({ error: "unavailable" }, 503);
		}
	},
);

authed.post(
	"/submissions/:submissionId/parts",
	zValidator(
		"json",
		z.object({
			uploadId: z.string().min(1).max(1024),
			partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(50),
		}),
	),
	async (c) => {
		const submissionId = c.req.param("submissionId");
		if (!isSubmissionId(submissionId))
			return c.json({ error: "not_found" }, 404);
		const { uploadId, partNumbers } = c.req.valid("json");
		try {
			return c.json({
				urls: await presignParts(
					c.get("user").id,
					submissionId,
					uploadId,
					partNumbers,
				),
			});
		} catch (error) {
			console.error("[recording-repair] presign failed", error);
			return c.json({ error: "unavailable" }, 503);
		}
	},
);

authed.post(
	"/submissions/:submissionId/complete",
	zValidator(
		"json",
		z.object({
			uploadId: z.string().min(1).max(1024),
			parts: z
				.array(
					z.object({
						partNumber: z.number().int().min(1).max(10_000),
						etag: z.string().min(1).max(256),
					}),
				)
				.min(1)
				.max(10_000),
		}),
	),
	async (c) => {
		const submissionId = c.req.param("submissionId");
		if (!isSubmissionId(submissionId))
			return c.json({ error: "not_found" }, 404);
		const user = c.get("user");
		const { uploadId, parts } = c.req.valid("json");
		try {
			await completeSubmission({
				userId: user.id,
				userEmail: user.email,
				submissionId,
				uploadId,
				parts,
			});
			return c.json({ ok: true });
		} catch (error) {
			console.error("[recording-repair] submission complete failed", error);
			return c.json({ error: "unavailable" }, 503);
		}
	},
);

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
