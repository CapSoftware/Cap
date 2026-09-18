import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import app from "../../app";
import { getEditorSession } from "../../lib/editor-sessions";

const runFile = promisify(execFile);
const secret = "editor-clip-benchmark-secret";
const longSeconds = 900;
const clipCount = 49;

async function makeLongMedia(input: string, output: string, loops: number) {
	await runFile(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-stream_loop",
			String(loops),
			"-i",
			input,
			"-c",
			"copy",
			"-t",
			String(longSeconds),
			output,
		],
		{ timeout: 60_000 },
	);
	const { stdout } = await runFile(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "json", output],
		{ timeout: 30_000 },
	);
	const duration = Number(
		(JSON.parse(stdout) as { format: { duration: string } }).format.duration,
	);
	assert.ok(Math.abs(duration - longSeconds) < 0.1);
}

async function nativeRssMb(pid: number | null) {
	if (pid === null) return null;
	const { stdout } = await runFile("ps", ["-o", "rss=", "-p", String(pid)]);
	const kilobytes = Number(stdout.trim());
	return Number.isFinite(kilobytes)
		? Math.round((kilobytes / 1024) * 10) / 10
		: null;
}

async function waitForPreparation(id: string, headers: Record<string, string>) {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const response = await app.request(`/editor/preparations/${id}`, {
			headers,
		});
		assert.equal(response.status, 200);
		const result = (await response.json()) as {
			status: string;
			sessionId?: string;
			error?: string;
		};
		if (result.status === "ready") {
			assert.ok(result.sessionId);
			return result.sessionId;
		}
		if (result.status === "error")
			throw new Error(result.error ?? "Native preparation failed");
		await Bun.sleep(100);
	}
	throw new Error("Native preparation timed out");
}

async function seekPreview(
	sessionId: string,
	seconds: number,
	headers: Record<string, string>,
) {
	const started = performance.now();
	const response = await app.request(`/editor/sessions/${sessionId}/preview`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			frameNumber: Math.floor(seconds * 30),
			fps: 30,
			resolutionBase: { x: 640, y: 360 },
		}),
	});
	assert.equal(response.status, 200);
	const bytes = Buffer.from(await response.arrayBuffer());
	const stride = bytes.readUInt32LE(bytes.length - 24);
	const offset = 180 * stride + 320 * 4;
	const red = bytes[offset] ?? 0;
	const blue = bytes[offset + 2] ?? 0;
	assert.ok(
		seconds < 903 ? red - blue > 100 : blue - red > 100,
		`Incorrect source at ${seconds}s: red=${red}, blue=${blue}`,
	);
	return Math.round((performance.now() - started) * 10) / 10;
}

assert.ok(process.env.CAP_WEB_EDITOR_PREPARE_BIN);
assert.ok(process.env.CAP_WEB_EDITOR_SERVICE_BIN);
const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const previousAllowHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
const fixtures = join(import.meta.dir, "../fixtures/editor-clips");
const original = join(fixtures, "display-red.webm");
const imported = join(fixtures, "clip-blue-audio.mp4");
const camera = join(fixtures, "camera-green.webm");
const temporary = await mkdtemp(join(tmpdir(), "cap-editor-clip-bench-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let sessionId: string | null = null;
try {
	const longDisplay = join(temporary, "long-display.webm");
	const longCamera = join(temporary, "long-camera.webm");
	await Promise.all([
		makeLongMedia(original, longDisplay, 299),
		makeLongMedia(camera, longCamera, 449),
	]);
	const paths = new Map([
		["/original.webm", original],
		["/imported.mp4", imported],
		["/camera.webm", camera],
		["/long-display.webm", longDisplay],
		["/long-camera.webm", longCamera],
	]);
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = paths.get(new URL(request.url).pathname);
			return path
				? new Response(Bun.file(path))
				: new Response("Missing fixture", { status: 404 });
		},
	});
	const headers = {
		"x-media-server-secret": secret,
		"Content-Type": "application/json",
	};
	const base = `http://127.0.0.1:${server.port}`;
	const clips = Array.from({ length: clipCount }, (_, index) => {
		const duration = index === 0 ? longSeconds : 2;
		return {
			displayPath: `content/videos/${randomUUID()}.${index === 0 ? "webm" : "mp4"}`,
			cameraPath: `content/videos/${randomUUID()}.webm`,
			duration,
			fps: 30,
			hasAudio: index !== 0,
			cameraFps: 25,
			cameraOffsetMs: 125,
		};
	});
	const [longDisplaySize, longCameraSize, importedSize, cameraSize] =
		await Promise.all([
			stat(longDisplay),
			stat(longCamera),
			stat(imported),
			stat(camera),
		]);
	const videoAssets = clips.flatMap((clip, index) => [
		{
			path: clip.displayPath,
			name: `Screen clip ${index + 1}`,
			url: `${base}/${index === 0 ? "long-display.webm" : "imported.mp4"}`,
			size: index === 0 ? longDisplaySize.size : importedSize.size,
			contentType: index === 0 ? "video/webm" : "video/mp4",
		},
		{
			path: clip.cameraPath,
			name: `Camera clip ${index + 1}`,
			url: `${base}/${index === 0 ? "long-camera.webm" : "camera.webm"}`,
			size: index === 0 ? longCameraSize.size : cameraSize.size,
			contentType: "video/webm",
		},
	]);
	const started = performance.now();
	const preparation = await app.request("/editor/preparations", {
		method: "POST",
		headers,
		body: JSON.stringify({
			videoId: "editor-clip-benchmark",
			title: "Fifteen minute, 49 clip benchmark",
			display: {
				url: `${base}/original.webm`,
				contentType: "video/webm",
				size: (await stat(original)).size,
				fps: 30,
			},
			videoAssets,
			clips,
			projectConfig: {
				camera: { hide: true },
				timeline: {
					segments: [
						{ recordingSegment: 0, timescale: 1, start: 0, end: 3 },
						...clips.map((clip, index) => ({
							recordingSegment: index + 1,
							timescale: 1,
							start: 0,
							end: clip.duration,
						})),
					],
					zoomSegments: [],
				},
			},
		}),
	});
	assert.equal(preparation.status, 202);
	const created = (await preparation.json()) as { id: string };
	sessionId = await waitForPreparation(created.id, headers);
	const prepareMs = Math.round(performance.now() - started);
	const native = getEditorSession(sessionId);
	assert.ok(native);
	const instanceResponse = await app.request(
		`/editor/sessions/${sessionId}/instance`,
		{ headers },
	);
	assert.equal(instanceResponse.status, 200);
	const instance = (await instanceResponse.json()) as {
		recordings: { segments: unknown[] };
	};
	assert.equal(instance.recordings.segments.length, clipCount + 1);
	const nativeRssBeforeMb = await nativeRssMb(native.pid);
	const seeks = [];
	for (const seconds of [30, 100, 450, 800, 899, 903.5, 920, 950, 985, 998]) {
		seeks.push({ seconds, ms: await seekPreview(sessionId, seconds, headers) });
	}
	const sorted = seeks.map((seek) => seek.ms).sort((a, b) => a - b);
	const nativeRssAfterMb = await nativeRssMb(native.pid);
	process.stdout.write(
		`${JSON.stringify({
			clipCount,
			assetCount: videoAssets.length,
			projectSeconds: 3 + longSeconds + (clipCount - 1) * 2,
			prepareMs,
			seeks,
			seekMedianMs: sorted[Math.floor(sorted.length / 2)],
			seekP95Ms: sorted[Math.floor(sorted.length * 0.95)],
			nativeRssBeforeMb,
			nativeRssAfterMb,
			workerRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
		})}\n`,
	);
} finally {
	if (sessionId)
		await app.request(`/editor/sessions/${sessionId}`, {
			method: "DELETE",
			headers: { "x-media-server-secret": secret },
		});
	server?.stop(true);
	await rm(temporary, { recursive: true, force: true });
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
	if (previousAllowHttp === undefined)
		delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousAllowHttp;
}
