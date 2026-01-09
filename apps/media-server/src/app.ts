import { Hono } from "hono";
import { logger } from "hono/logger";
import audio from "./routes/audio";
import health from "./routes/health";

const app = new Hono();

app.use("*", logger());

app.route("/health", health);
app.route("/audio", audio);

app.get("/", (c) => {
	return c.json({
		name: "@cap/media-server",
		version: "1.0.0",
		endpoints: ["/health", "/audio/status", "/audio/check", "/audio/extract"],
	});
});

export default app;
