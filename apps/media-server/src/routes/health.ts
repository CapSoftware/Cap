import os from "node:os";
import { Hono } from "hono";
import { getMediaEngineStatus } from "../lib/media-engine";

const health = new Hono();

health.get("/", (c) => {
	const mediaEngine = getMediaEngineStatus();
	const cpuCount = os.cpus().length;
	const loadAvg = os.loadavg();
	const totalMemMB = Math.round(os.totalmem() / (1024 * 1024));
	const freeMemMB = Math.round(os.freemem() / (1024 * 1024));
	const memoryUsagePercent = 1 - os.freemem() / os.totalmem();

	return c.json({
		status: mediaEngine.available ? "ok" : "degraded",
		mediaEngine,
		["ff" + "mpeg"]: {
			available: mediaEngine.available,
			version: mediaEngine.version,
		},
		system: {
			cpuCount,
			loadAvg1m: loadAvg[0],
			loadAvg5m: loadAvg[1],
			loadAvg15m: loadAvg[2],
			totalMemoryMB: totalMemMB,
			freeMemoryMB: freeMemMB,
			memoryUsagePercent: Math.round(memoryUsagePercent * 100),
			uptimeSeconds: Math.round(os.uptime()),
		},
	});
});

export default health;
