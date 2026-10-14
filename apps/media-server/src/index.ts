import app from "./app";
import {
	abortAllJobs,
	beginDraining,
	getActiveVideoProcessCount,
	waitForActiveVideoProcesses,
} from "./lib/job-manager";
import { cancelAllMediaOperations } from "./lib/media-operations";
import { cleanupMediaTransferCache } from "./lib/media-transfer";
import { assertSecureStartup } from "./lib/startup-checks";

assertSecureStartup();

const port = Number(process.env.PORT) || 3456;
const shutdownGraceMs = Math.max(
	0,
	Number.parseInt(process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS ?? "25000", 10) ||
		0,
);

console.log(`[media-server] Starting on port ${port}`);

let shuttingDown = false;

const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	beginDraining();
	const active = getActiveVideoProcessCount();
	if (active > 0 && shutdownGraceMs > 0) {
		console.log(
			`[media-server] Draining: waiting up to ${Math.round(shutdownGraceMs / 1000)}s for ${active} active video job(s); new work is rejected with SERVER_BUSY`,
		);
		const remaining = await waitForActiveVideoProcesses(shutdownGraceMs);
		console.log(
			remaining === 0
				? "[media-server] All active jobs finished"
				: `[media-server] Grace period over with ${remaining} job(s) still running`,
		);
	}
	console.log("[media-server] Shutting down...");
	const abortedJobs = await abortAllJobs();
	if (abortedJobs > 0) {
		console.log(`[media-server] Aborted ${abortedJobs} active jobs`);
	}
	await cancelAllMediaOperations();
	await cleanupMediaTransferCache();
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
