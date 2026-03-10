import os from "node:os";
import { spawn } from "bun";
import { Hono } from "hono";

const health = new Hono();

health.get("/", async (c) => {
	let ffmpegVersion = "unknown";
	let ffmpegAvailable = false;

	try {
		const proc = spawn({
			cmd: ["ffmpeg", "-version"],
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		if (exitCode === 0) {
			ffmpegAvailable = true;
			const versionMatch = stdout.match(/ffmpeg version (\S+)/);
			if (versionMatch) {
				ffmpegVersion = versionMatch[1];
			}
		}
	} catch {}

	const cpuCount = os.cpus().length;
	const loadAvg = os.loadavg();
	const totalMemMB = Math.round(os.totalmem() / (1024 * 1024));
	const freeMemMB = Math.round(os.freemem() / (1024 * 1024));
	const memoryUsagePercent = 1 - os.freemem() / os.totalmem();

	return c.json({
		status: ffmpegAvailable ? "ok" : "degraded",
		ffmpeg: {
			available: ffmpegAvailable,
			version: ffmpegVersion,
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
