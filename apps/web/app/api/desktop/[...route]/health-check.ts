import { Hono } from "hono";
import { withOptionalAuth } from "../../utils";

export const app = new Hono();

app.get("/", withOptionalAuth, async (c) => {
	const isAuthCheck = c.req.header("X-Auth-Check") === "true";
	const user = c.get("user");

	if (isAuthCheck && !user) {
		return c.json({ ok: false, message: "Not authenticated" }, 401);
	}

	return c.json({
		ok: true,
		timestamp: Date.now(),
		authenticated: !!user,
	});
});

app.post("/", withOptionalAuth, async (c) => {
	const isSpeedTest = c.req.header("X-Speed-Test") === "true";
	const isUploadTest = c.req.header("X-Upload-Test") === "true";

	if (isSpeedTest || isUploadTest) {
		try {
			const body = await c.req.arrayBuffer();
			return c.json({
				ok: true,
				bytesReceived: body.byteLength,
				timestamp: Date.now(),
			});
		} catch {
			return c.json({ ok: false, message: "Failed to process upload" }, 500);
		}
	}

	return c.json({ ok: true, timestamp: Date.now() });
});
