import app from "./app";
import { abortAllJobs } from "./lib/job-manager";
import { terminateAllSubprocesses } from "./lib/subprocess";

const port = Number(process.env.PORT) || 3456;

console.log(`[media-server] Starting on port ${port}`);

let shuttingDown = false;

const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("[media-server] Shutting down...");
	const abortedJobs = abortAllJobs();
	if (abortedJobs > 0) {
		console.log(`[media-server] Aborted ${abortedJobs} active jobs`);
	}
	await terminateAllSubprocesses();
	process.exit(0);
};

process.on("SIGINT", () => {
	void shutdown();
});
process.on("SIGTERM", () => {
	void shutdown();
});
process.on("SIGHUP", () => {
	void shutdown();
});

export default {
	port,
	fetch: app.fetch,
};
