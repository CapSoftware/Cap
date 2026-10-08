import { Hono } from "hono";
import { withOptionalAuth } from "../../utils";

export const app = new Hono().use(withOptionalAuth);

app.get("/", (c) => {
	return c.json({
		status: "ok",
		service: "cap-desktop-health",
		timestamp: Date.now(),
	});
});

app.post("/", async (c) => {
	try {
		const contentType = c.req.header("content-type") || "";
		let bytesReceived = 0;

		if (contentType.includes("application/json")) {
			const json = await c.req.json().catch(() => ({}));
			const payload = typeof json.payload === "string" ? json.payload : "";
			bytesReceived = Buffer.byteLength(payload, "utf8");
		} else {
			const bodyBuffer = await c.req
				.arrayBuffer()
				.catch(() => new ArrayBuffer(0));
			bytesReceived = bodyBuffer.byteLength;
		}

		return c.json({
			status: "ok",
			healthy: true,
			bytesReceived,
			timestamp: Date.now(),
		});
	} catch (error) {
		return c.json(
			{
				status: "error",
				healthy: false,
				error: error instanceof Error ? error.message : "Health check failed",
				timestamp: Date.now(),
			},
			500,
		);
	}
});

app.post("/speed-test", async (c) => {
	try {
		const body = await c.req.arrayBuffer().catch(() => new ArrayBuffer(0));
		return c.json({
			status: "ok",
			bytesReceived: body.byteLength,
			timestamp: Date.now(),
		});
	} catch (error) {
		return c.json(
			{
				status: "error",
				error: error instanceof Error ? error.message : "Speed test failed",
			},
			500,
		);
	}
});
