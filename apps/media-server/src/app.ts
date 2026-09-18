import { Hono } from "hono";
import { logger } from "hono/logger";
import audio from "./routes/audio";
import editor from "./routes/editor";
import health from "./routes/health";
import video from "./routes/video";

const app = new Hono();

const accessLogger = logger();
app.use("*", (c, next) =>
	/^\/editor\/sessions\/[0-9a-f-]{36}\/exports\/[0-9a-f-]{36}\/download$/.test(
		c.req.path,
	)
		? next()
		: accessLogger(c, next),
);

app.route("/health", health);
app.route("/audio", audio);
app.route("/editor", editor);
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
			"/editor/preparations",
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
