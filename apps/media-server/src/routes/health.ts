import os from "node:os";
import { Hono } from "hono";
import { getSystemResources } from "../lib/job-manager";
import { getMediaEngineStatus } from "../lib/media-engine";

const health = new Hono();

health.get("/", (c) => {
	const mediaEngine = getMediaEngineStatus();
	const [, loadAvg5m, loadAvg15m] = os.loadavg();
	const totalMemoryBytes = os.totalmem();
	const freeMemoryBytes = os.freemem();
	const totalMemoryMB = Math.round(totalMemoryBytes / (1024 * 1024));
	const freeMemoryMB = Math.round(freeMemoryBytes / (1024 * 1024));
	const memoryUsagePercent = Math.round(
		(1 - freeMemoryBytes / totalMemoryBytes) * 100,
	);
	const resources = getSystemResources();

	return c.json({
		status:
			mediaEngine.available && resources.effectiveMax > 0 ? "ok" : "degraded",
		mediaEngine,
		["ff" + "mpeg"]: {
			available: mediaEngine.available,
			version: mediaEngine.version,
		},
		system: {
			...resources,
			loadAvg5m,
			loadAvg15m,
			totalMemoryMB,
			freeMemoryMB,
			memoryUsagePercent,
			uptimeSeconds: Math.round(os.uptime()),
			processUptimeSeconds: Math.round(process.uptime()),
		},
	});
});

export default health;
