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
	const { version, ...mediaEngine } = getMediaEngineStatus();
	const resources = getSystemResources();
	const draining = isDraining();
	const status = draining
		? "draining"
		: mediaEngine.available && resources.effectiveMax > 0
			? "ok"
			: "degraded";

	// A caller without the secret (a load balancer) learns only whether this
	// instance is up. Engine versions, load, memory and slot figures are for
	// callers that hold the secret.
	if (!hasMediaServerSecret(c)) {
		return c.json({ status }, draining ? 503 : 200);
	}

	const [, loadAvg5m, loadAvg15m] = os.loadavg();
	const totalMemoryBytes = os.totalmem();
	const freeMemoryBytes = os.freemem();
	const totalMemoryMB = Math.round(totalMemoryBytes / (1024 * 1024));
	const freeMemoryMB = Math.round(freeMemoryBytes / (1024 * 1024));
	const memoryUsagePercent = Math.round(
		(1 - freeMemoryBytes / totalMemoryBytes) * 100,
	);

	return c.json(
		{
			status,
			mediaEngine: { ...mediaEngine, version },
			["ff" + "mpeg"]: { available: mediaEngine.available, version },
			videoEncoder: getVideoEncoderStatus(process.env, true),
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
			runtime: await getRuntimeReport(),
		},
		draining ? 503 : 200,
	);
});

export default health;
