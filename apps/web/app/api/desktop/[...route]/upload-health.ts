import { Hono } from "hono";
import { withAuth } from "../../utils";

export const app = new Hono().use(withAuth);

export const MAX_UPLOAD_PROBE_BYTES = 1024 * 1024;

app.get("/", (c) => c.json({ ok: true }));

app.post("/", async (c) => {
	const contentLength = Number(c.req.header("content-length") ?? 0);
	if (contentLength > MAX_UPLOAD_PROBE_BYTES)
		return c.json({ error: "Probe payload too large" }, { status: 413 });

	const body = c.req.raw.body;
	if (body === null) return c.json({ receivedBytes: 0 });

	let receivedBytes = 0;
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > MAX_UPLOAD_PROBE_BYTES) {
				await reader.cancel();
				return c.json({ error: "Probe payload too large" }, { status: 413 });
			}
		}
	} finally {
		reader.releaseLock();
	}

	return c.json({ receivedBytes });
});
