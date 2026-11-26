import { logger } from "hono/logger";
import { getIdleTimeoutSeconds } from "../lib/lifecycle";
import { installUnhandledRejectionGuard } from "../lib/process-guards";
import { createLoomImporter } from "./app";

installUnhandledRejectionGuard();

const port = Number(process.env.PORT) || 3456;
const drainTimeoutMs =
	Number(process.env.LOOM_IMPORTER_DRAIN_TIMEOUT_MS) || 10 * 60 * 1000;
const importer = createLoomImporter();

importer.app.use("*", logger());

let stopping = false;
const shutdown = async (signal: string) => {
	if (stopping) process.exit(1);
	stopping = true;
	console.log(`[loom-importer] ${signal}: draining`, importer.stats());
	try {
		await importer.drain(drainTimeoutMs);
	} catch (error) {
		console.error("[loom-importer] Drain failed", error);
		process.exit(1);
	}
	process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
	process.on(signal, () => void shutdown(signal));

console.log(`[loom-importer] Starting on port ${port}`);

export default {
	port,
	idleTimeout: getIdleTimeoutSeconds(),
	fetch: importer.app.fetch,
};
