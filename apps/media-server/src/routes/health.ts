import { spawn } from "bun";
import { Hono } from "hono";
import {
	canAcceptNewVideoProcess,
	getActiveVideoProcessCount,
	getSystemResources,
} from "../lib/job-manager";

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

	const resources = getSystemResources();

	return c.json({
		status: ffmpegAvailable ? "ok" : "degraded",
		ffmpeg: {
			available: ffmpegAvailable,
			version: ffmpegVersion,
		},
		activeVideoProcesses: getActiveVideoProcessCount(),
		canAcceptNewVideoProcess: canAcceptNewVideoProcess(),
		resources,
	});
});

export default health;
