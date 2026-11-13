import { Hono } from "hono";
import { withAuth } from "../../utils";

export const app = new Hono();

const MAX_PROBE_BYTES = 8 * 1024 * 1024;

app.get("/", withAuth, (c) => c.json({ ok: true }));

app.post("/", withAuth, async (c) => {
	const body = await c.req.arrayBuffer();
	if (body.byteLength > MAX_PROBE_BYTES) {
		return c.json({ error: true, code: "payload_too_large" }, 413);
	}
	return c.json({ ok: true, received: body.byteLength });
});
