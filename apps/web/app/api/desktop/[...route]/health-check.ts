import { Hono } from "hono";
import { withAuth } from "../../utils";

export const app = new Hono();

const MAX_PROBE_BYTES = 8 * 1024 * 1024;

app.get("/", withAuth, (c) => c.json({ ok: true }));

app.post("/", withAuth, async (c) => {
	const contentLength = c.req.header("content-length");
	if (contentLength && parseInt(contentLength, 10) > MAX_PROBE_BYTES) {
		return c.json({ error: true, code: "payload_too_large" }, 413);
	}
	if (!c.req.raw.body) {
		return c.json({ ok: true, received: 0 });
	}
	const reader = c.req.raw.body.getReader();
	let bytesReceived = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytesReceived += value.byteLength;
		if (bytesReceived > MAX_PROBE_BYTES) {
			await reader.cancel();
			return c.json({ error: true, code: "payload_too_large" }, 413);
		}
	}
	return c.json({ ok: true, received: bytesReceived });
});
