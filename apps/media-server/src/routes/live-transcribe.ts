import { Hono } from "hono";
import { canReadStatus, validateMediaServerSecret } from "../lib/auth";
import { DRAIN_RETRY_AFTER_SECONDS, isDraining } from "../lib/lifecycle";
import {
	canAcceptLiveSession,
	getLiveSessionCount,
	startLiveSession,
	startLiveSessionSchema,
} from "../lib/live-transcribe";

const liveTranscribe = new Hono();

liveTranscribe.get("/status", (c) => {
	if (!canReadStatus(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	return c.json({
		sessions: getLiveSessionCount(),
		canAcceptNewSession: !isDraining() && canAcceptLiveSession(),
	});
});

liveTranscribe.post("/sessions", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const result = startLiveSessionSchema.safeParse(
		await c.req.json().catch(() => null),
	);
	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	if (isDraining() || !canAcceptLiveSession()) {
		c.header("Retry-After", DRAIN_RETRY_AFTER_SECONDS.toString());
		return c.json({ error: "Server is busy", code: "SERVER_BUSY" }, 503);
	}

	startLiveSession(result.data);
	return c.json({ accepted: true }, 202);
});

export default liveTranscribe;
