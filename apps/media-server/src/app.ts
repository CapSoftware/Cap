import { Hono } from "hono";
import { logger } from "hono/logger";
import { beginRequest } from "./lib/lifecycle";
import audio from "./routes/audio";
import health from "./routes/health";
import video from "./routes/video";

const app = new Hono();

app.use("*", logger());
app.use("*", async (c, next) => {
	if (c.req.method === "GET" || c.req.method === "HEAD") return await next();
	const end = beginRequest();
	try {
		await next();
	} finally {
		end();
	}
});

app.route("/health", health);
app.route("/audio", audio);
app.route("/video", video);

app.get("/", (c) => {
	return c.json({
		name: "@cap/media-server",
		version: "1.0.0",
		endpoints: [
			"/health",
			"/audio/status",
			"/audio/check",
			"/audio/extract",
			"/audio/convert",
			"/video/status",
			"/video/probe",
			"/video/thumbnail",
			"/video/convert",
			"/video/process",
			"/video/edit",
			"/video/process/:jobId/status",
			"/video/process/:jobId/cancel",
			"/video/cleanup",
			"/video/force-cleanup",
		],
	});
});

export default app;
