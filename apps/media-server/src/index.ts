import app from "./app";
import { abortAllJobs } from "./lib/job-manager";
import { createShutdownHandler, getIdleTimeoutSeconds } from "./lib/lifecycle";
import { cancelAllMediaOperations } from "./lib/media-operations";
import {
	cleanupMediaTransferCache,
	sweepMediaTransferCache,
} from "./lib/media-transfer";
import { removeOwnTempDir, startTempDirMaintenance } from "./lib/temp-files";

const port = Number(process.env.PORT) || 3456;

console.log(`[media-server] Starting on port ${port}`);

void Promise.allSettled([
	startTempDirMaintenance(),
	sweepMediaTransferCache(),
]).then(([temp, cache]) => {
	const removed =
		(temp.status === "fulfilled" ? temp.value : 0) +
		(cache.status === "fulfilled" ? cache.value : 0);
	if (removed > 0) {
		console.log(`[media-server] Removed ${removed} orphaned temp entries`);
	}
});

const shutdown = createShutdownHandler(async () => {
	const abortedJobs = await abortAllJobs();
	if (abortedJobs > 0) {
		console.log(`[media-server] Aborted ${abortedJobs} active jobs`);
	}
	await cancelAllMediaOperations();
	await cleanupMediaTransferCache();
	await removeOwnTempDir();
	process.exit(0);
});

process.on("SIGINT", () => {
	void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
	void shutdown("SIGTERM");
});
process.on("SIGHUP", () => {
	void shutdown("SIGHUP");
});

export default {
	port,
	idleTimeout: getIdleTimeoutSeconds(),
	fetch: app.fetch,
};
