import os from "node:os";
import { Hono } from "hono";
import { getSystemResources } from "../lib/job-manager";
import { getMediaEngineStatus } from "../lib/media-engine";

const health = new Hono();

health.get("/", (c) => {
	const mediaEngine = getMediaEngineStatus();
	const loadAvg = os.loadavg();
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
			loadAvg1m: loadAvg[0],
			loadAvg5m: loadAvg[1],
			loadAvg15m: loadAvg[2],
			uptimeSeconds: Math.round(process.uptime()),
		},
	});
});

export default health;
