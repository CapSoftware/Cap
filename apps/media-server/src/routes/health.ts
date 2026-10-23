import os from "node:os";
import { Hono } from "hono";
import { hasMediaServerSecret } from "../lib/auth";
import { getSystemResources } from "../lib/job-manager";
import { isDraining } from "../lib/lifecycle";
import { getMediaEngineStatus } from "../lib/media-engine";
import { getVideoEncoderStatus } from "../lib/nvenc-encoder";
import { getRuntimeReport } from "../lib/runtime-report";

const health = new Hono();

health.get("/", async (c) => {
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
	const draining = isDraining();
	const authenticated = hasMediaServerSecret(c);

	return c.json(
		{
			status: draining
				? "draining"
				: mediaEngine.available && resources.effectiveMax > 0
					? "ok"
					: "degraded",
			mediaEngine,
			["ff" + "mpeg"]: {
				available: mediaEngine.available,
				version: mediaEngine.version,
			},
			videoEncoder: getVideoEncoderStatus(process.env, authenticated),
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
			...(authenticated && { runtime: await getRuntimeReport() }),
		},
		draining ? 503 : 200,
	);
});

export default health;
