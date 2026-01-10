import app from "./app";

const port = Number(process.env.PORT) || 3456;

console.log(`[media-server] Starting on port ${port}`);

const shutdown = () => {
	console.log("[media-server] Shutting down...");
	process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

export default {
	port,
	fetch: app.fetch,
};
