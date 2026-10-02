import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { type Browser, chromium, webkit } from "@playwright/test";
import sharp from "sharp";
import app from "../../editor-worker-app";
import { getEditorSession } from "../../lib/editor-sessions";
import {
	editorWebSocketHandler,
	handleEditorSocketUpgrade,
} from "../../lib/editor-websocket";

const runFile = promisify(execFile);
const secret = "editor-1080p-benchmark-secret";
const longSeconds = 900;
const downloadMbps = process.env.CAP_EDITOR_BENCHMARK_DOWNLOAD_MBPS
	? Number(process.env.CAP_EDITOR_BENCHMARK_DOWNLOAD_MBPS)
	: null;
const playbackFps = process.env.CAP_EDITOR_BENCHMARK_FPS
	? Number(process.env.CAP_EDITOR_BENCHMARK_FPS)
	: 30;
const measureLosslessDelta =
	process.env.CAP_EDITOR_BENCHMARK_DELTA_PROBE === "1";
const measureH264 = process.env.CAP_EDITOR_BENCHMARK_H264_PROBE === "1";
const nativeH264 = process.env.CAP_EDITOR_BENCHMARK_NATIVE_H264 === "1";
const browserEngine =
	process.env.CAP_EDITOR_BENCHMARK_BROWSER === "webkit" ? webkit : chromium;
const seekDuringH264 =
	process.env.CAP_EDITOR_BENCHMARK_SEEK_DURING_H264 === "1";
const measureMovingQuality =
	process.env.CAP_EDITOR_BENCHMARK_MOVING_QUALITY === "1";
const movingArtifactDirectory =
	process.env.CAP_EDITOR_BENCHMARK_MOVING_ARTIFACT_DIR;
assert.ok(
	downloadMbps === null || (Number.isFinite(downloadMbps) && downloadMbps > 0),
	"Benchmark download bandwidth must be a positive number",
);
assert.ok(
	downloadMbps === null || browserEngine === chromium,
	"Bandwidth emulation requires Chromium",
);
assert.ok(
	Number.isInteger(playbackFps) && playbackFps >= 1 && playbackFps <= 60,
	"Benchmark frame rate must be between one and sixty",
);

type BrowserFrameBenchmark = {
	collecting: boolean;
	frameTimes: number[];
	paintTimes: number[];
	frameNumbers: number[];
	lastFrameNumber: number | null;
	webCodecsAvailable: boolean;
	requestedModes: string[];
	socketCloseCode: number | null;
	rawBytes: number;
	longTasks: number;
};

async function makeScreen(path: string) {
	await runFile(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=1920x1080:rate=30",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000",
			"-t",
			"24",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"28",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"96k",
			"-movflags",
			"+faststart",
			path,
		],
		{ timeout: 180_000 },
	);
}

async function makeCamera(path: string) {
	await runFile(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=1280x720:rate=25",
			"-t",
			"24",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"29",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			path,
		],
		{ timeout: 180_000 },
	);
}

async function loopMedia(input: string, output: string) {
	await runFile(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-stream_loop",
			"-1",
			"-i",
			input,
			"-c",
			"copy",
			"-t",
			String(longSeconds),
			output,
		],
		{ timeout: 180_000 },
	);
}

async function nativeRssMb(pid: number | null) {
	if (pid === null) return null;
	const { stdout } = await runFile("ps", ["-o", "rss=", "-p", String(pid)]);
	const kilobytes = Number(stdout.trim());
	return Number.isFinite(kilobytes)
		? Math.round((kilobytes / 1024) * 10) / 10
		: null;
}

async function nativeCpuPercent(pid: number | null) {
	if (pid === null) return null;
	const { stdout } = await runFile("ps", ["-o", "%cpu=", "-p", String(pid)]);
	const percentage = Number(stdout.trim());
	return Number.isFinite(percentage) ? percentage : null;
}

async function losslessDeltaProbe(packets: Buffer[]) {
	assert.ok(
		packets.length >= 30,
		"Lossless delta probe received too few frames",
	);
	let previous: Buffer | null = null;
	let changedBytes = 0;
	let comparedBytes = 0;
	const fullSizes: number[] = [];
	const deltaSizes: number[] = [];
	const frameNumbers: number[] = [];
	for (const packet of packets) {
		assert.equal(packet.subarray(0, 8).toString(), "CAPPNG01");
		const footerOffset = packet.length - 24;
		frameNumbers.push(packet.readUInt32LE(footerOffset + 12));
		fullSizes.push(packet.length);
		const decoded = await sharp(packet.subarray(8, footerOffset))
			.raw()
			.toBuffer({ resolveWithObject: true });
		assert.equal(decoded.info.width, 1920);
		assert.equal(decoded.info.height, 1080);
		assert.equal(decoded.info.channels, 4);
		if (previous) {
			const difference = Buffer.allocUnsafe(decoded.data.length);
			for (let index = 0; index < difference.length; index++) {
				const byte = decoded.data[index] ^ previous[index];
				difference[index] = byte;
				if (byte !== 0) changedBytes++;
			}
			comparedBytes += difference.length;
			deltaSizes.push(deflateSync(difference, { level: 1 }).length);
		}
		previous = decoded.data;
	}
	const meanFullBytes =
		fullSizes.reduce((sum, size) => sum + size, 0) / fullSizes.length;
	const meanDeltaBytes =
		deltaSizes.reduce((sum, size) => sum + size, 0) / deltaSizes.length;
	return {
		frames: packets.length,
		firstFrameNumber: frameNumbers[0],
		lastFrameNumber: frameNumbers.at(-1),
		changedBytePercent: Math.round((changedBytes / comparedBytes) * 1000) / 10,
		meanFullBytes: Math.round(meanFullBytes),
		meanDeltaBytes: Math.round(meanDeltaBytes),
		estimated30FpsMbpsWithOneKeyframePerSecond:
			Math.round(((meanFullBytes + meanDeltaBytes * 29) * 8) / 100_000) / 10,
	};
}

async function h264PreviewProbe(packets: Buffer[], temporary: string) {
	assert.ok(packets.length >= 60, "H.264 probe received too few frames");
	const directory = join(temporary, "h264-probe");
	await mkdir(directory);
	await Promise.all(
		packets.slice(0, 60).map((packet, index) => {
			assert.equal(packet.subarray(0, 8).toString(), "CAPPNG01");
			return writeFile(
				join(directory, `frame-${String(index).padStart(3, "0")}.png`),
				packet.subarray(8, packet.length - 24),
			);
		}),
	);
	const results = [];
	for (const crf of [18, 20, 24]) {
		const output = join(directory, `preview-crf-${crf}.h264`);
		const started = performance.now();
		await runFile(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-framerate",
				"30",
				"-i",
				join(directory, "frame-%03d.png"),
				"-frames:v",
				"60",
				"-c:v",
				"libx264",
				"-threads",
				"4",
				"-preset",
				"ultrafast",
				"-tune",
				"zerolatency",
				"-crf",
				String(crf),
				"-g",
				"30",
				"-pix_fmt",
				"yuv420p",
				"-f",
				"h264",
				output,
			],
			{ timeout: 120_000 },
		);
		const size = (await stat(output)).size;
		results.push({
			crf,
			bytes: size,
			estimatedMbps: Math.round((size * 8) / 2 / 100_000) / 10,
			encodeFramesPerSecond:
				Math.round((60_000 / (performance.now() - started)) * 10) / 10,
		});
	}
	return results;
}

async function readySession(id: string, headers: Record<string, string>) {
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const response = await app.request(`/editor/preparations/${id}`, {
			headers,
		});
		assert.equal(response.status, 200);
		const status = (await response.json()) as {
			status: string;
			sessionId?: string;
			error?: string;
		};
		if (status.status === "ready") {
			assert.ok(status.sessionId);
			return status.sessionId;
		}
		if (status.status === "error") {
			throw new Error(status.error ?? "Native preparation failed");
		}
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
			resolutionBase: { x: 1920, y: 1080 },
		}),
	});
	assert.equal(response.status, 200);
	const bytes = Buffer.from(await response.arrayBuffer());
	assert.ok(bytes.length >= 1920 * 1080 * 4);
	const stride = bytes.readUInt32LE(bytes.length - 24);
	assert.ok(stride >= 1920 * 4);
	return Math.round((performance.now() - started) * 10) / 10;
}

assert.ok(process.env.CAP_WEB_EDITOR_PREPARE_BIN);
assert.ok(process.env.CAP_WEB_EDITOR_SERVICE_BIN);
const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const previousAllowHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
const previousPublicOrigin = process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
const temporary = await mkdtemp(join(tmpdir(), "cap-editor-1080p-bench-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let socketServer: ReturnType<typeof Bun.serve> | null = null;
let frameSocket: WebSocket | null = null;
let browser: Browser | null = null;
let sessionId: string | null = null;
try {
	const socketModule = await Bun.build({
		entrypoints: [
			join(
				import.meta.dir,
				"../../../../../packages/editor-solid-web/src/websocket.ts",
			),
		],
		target: "browser",
		format: "esm",
		splitting: false,
	});
	assert.ok(socketModule.success);
	const socketCode = await socketModule.outputs[0]?.text();
	assert.ok(socketCode);
	const screen = join(temporary, "screen.mp4");
	const camera = join(temporary, "camera.mp4");
	const longScreen = join(temporary, "long-screen.mp4");
	const longCamera = join(temporary, "long-camera.mp4");
	await Promise.all([makeScreen(screen), makeCamera(camera)]);
	await Promise.all([
		loopMedia(screen, longScreen),
		loopMedia(camera, longCamera),
	]);
	const paths = new Map([
		["/screen.mp4", screen],
		["/camera.mp4", camera],
		["/long-screen.mp4", longScreen],
		["/long-camera.mp4", longCamera],
	]);
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/bench") {
				return new Response(
					"<!doctype html><html><body><canvas id='bench-canvas'></canvas></body></html>",
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				);
			}
			if (pathname === "/bench.js") {
				return new Response(socketCode, {
					headers: { "Content-Type": "text/javascript; charset=utf-8" },
				});
			}
			const path = paths.get(pathname);
			return path
				? new Response(Bun.file(path))
				: new Response("Missing fixture", { status: 404 });
		},
	});
	const sizes = await Promise.all(
		[screen, camera, longScreen, longCamera].map((path) => stat(path)),
	);
	const base = `http://127.0.0.1:${server.port}`;
	const screenPath = `content/videos/${randomUUID()}.mp4`;
	const cameraPath = `content/videos/${randomUUID()}.mp4`;
	const headers = {
		"x-media-server-secret": secret,
		"Content-Type": "application/json",
	};
	const started = performance.now();
	const preparation = await app.request("/editor/preparations", {
		method: "POST",
		headers,
		body: JSON.stringify({
			videoId: "editor-1080p-benchmark",
			title: "1080p screen, 720p webcam, fifteen minute clip",
			display: {
				url: `${base}/screen.mp4`,
				contentType: "video/mp4",
				size: sizes[0]?.size,
				fps: 30,
			},
			camera: {
				url: `${base}/camera.mp4`,
				contentType: "video/mp4",
				size: sizes[1]?.size,
				fps: 25,
				offsetMs: 125,
			},
			mixedAudioInDisplay: true,
			videoAssets: [
				{
					path: screenPath,
					name: "Long screen",
					url: `${base}/long-screen.mp4`,
					size: sizes[2]?.size,
					contentType: "video/mp4",
				},
				{
					path: cameraPath,
					name: "Long webcam",
					url: `${base}/long-camera.mp4`,
					size: sizes[3]?.size,
					contentType: "video/mp4",
				},
			],
			clips: [
				{
					displayPath: screenPath,
					cameraPath,
					duration: longSeconds,
					fps: 30,
					hasAudio: true,
					cameraFps: 25,
					cameraOffsetMs: 125,
				},
			],
		}),
	});
	assert.equal(preparation.status, 202);
	const created = (await preparation.json()) as { id: string };
	sessionId = await readySession(created.id, headers);
	const prepareMs = Math.round(performance.now() - started);
	const native = getEditorSession(sessionId);
	assert.ok(native);
	const instanceResponse = await app.request(
		`/editor/sessions/${sessionId}/instance`,
		{ headers },
	);
	assert.equal(instanceResponse.status, 200);
	const instance = (await instanceResponse.json()) as {
		recordingDuration: number;
		recordings: { segments: unknown[] };
	};
	assert.equal(instance.recordings.segments.length, 2);
	const rssBeforeMb = await nativeRssMb(native.pid);
	const seeks = [];
	for (const seconds of [1, 10, 23, 24.5, 90, 450, 800, 900, 922]) {
		seeks.push({ seconds, ms: await seekPreview(sessionId, seconds, headers) });
	}
	const endpointFrame = Math.ceil(instance.recordingDuration * 30);
	const endpointResponse = await app.request(
		`/editor/sessions/${sessionId}/preview`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				frameNumber: endpointFrame,
				fps: 30,
				resolutionBase: { x: 1920, y: 1080 },
			}),
		},
	);
	assert.equal(endpointResponse.status, 200);
	const placement = endpointResponse.headers.get("x-cap-frame-placement");
	assert.ok(placement);
	assert.equal(
		(JSON.parse(placement) as { frameNumber: number }).frameNumber,
		endpointFrame - 1,
	);
	for (const [path, method] of [
		["preview", "POST"],
		["playback", "POST"],
		["seek", "PUT"],
	] as const) {
		const rejectedStarted = performance.now();
		const rejected = await app.request(
			`/editor/sessions/${sessionId}/${path}`,
			{
				method,
				headers,
				body: JSON.stringify({
					frameNumber: endpointFrame + 30,
					fps: 30,
					resolutionBase: { x: 1920, y: 1080 },
				}),
			},
		);
		assert.equal(rejected.status, 400);
		assert.ok(performance.now() - rejectedStarted < 1000);
	}
	const sorted = seeks.map((seek) => seek.ms).sort((a, b) => a - b);
	const rssAfterSeeksMb = await nativeRssMb(native.pid);
	const relayDiagnostics: Array<{
		kind: string;
		message?: string;
		mode?: string;
		upstream?: string;
	}> = [];
	socketServer = Bun.serve({
		port: 0,
		fetch(request, listener) {
			const upgrade = handleEditorSocketUpgrade(request, listener);
			return upgrade === null ? app.fetch(request) : upgrade;
		},
		websocket: {
			...editorWebSocketHandler,
			message(ws, message) {
				if (ws.data.scope === "frames") {
					relayDiagnostics.push({
						kind: "control",
						message:
							typeof message === "string"
								? message
								: `binary:${message.byteLength}`,
						mode: ws.data.frameMode,
						upstream: ws.data.upstream?.url,
					});
				}
				editorWebSocketHandler.message?.(ws, message);
				if (ws.data.scope === "frames")
					relayDiagnostics.push({
						kind: "state",
						mode: ws.data.frameMode,
						upstream: ws.data.upstream?.url,
					});
			},
		},
	});
	process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = `http://127.0.0.1:${socketServer.port}`;
	const ticketsResponse = await app.request(
		`/editor/sessions/${sessionId}/sockets`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ origin: "http://127.0.0.1:3000" }),
		},
	);
	assert.equal(ticketsResponse.status, 200);
	const tickets = (await ticketsResponse.json()) as {
		sockets: { frames: { url: string; ticket: string } };
	};
	const BunWebSocket = WebSocket as unknown as new (
		url: string,
		options: Bun.WebSocketOptions,
	) => WebSocket;
	const nativeFrameUrl = new URL("/frames-h264", native.origin);
	nativeFrameUrl.protocol = "ws:";
	frameSocket = nativeH264
		? native.connectSocket(nativeFrameUrl.toString())
		: new BunWebSocket(tickets.sockets.frames.url, {
				protocols: [
					"cap-editor-v1",
					`cap-editor-ticket.${tickets.sockets.frames.ticket}`,
				],
				headers: { Origin: "http://127.0.0.1:3000" },
			});
	frameSocket.binaryType = "arraybuffer";
	const frameTimes: number[] = [];
	let frameBytes = 0;
	let collecting = false;
	let h264Config: string | null = null;
	let h264Keyframes = 0;
	let h264SequenceGaps = 0;
	let lastH264Sequence: number | null = null;
	const deltaPackets: Buffer[] = [];
	frameSocket.onmessage = (event: MessageEvent<unknown>) => {
		if (nativeH264 && typeof event.data === "string") {
			const message = JSON.parse(event.data) as {
				kind: string;
				codec?: string;
				error?: string;
			};
			if (message.kind === "cap-h264-config")
				h264Config = message.codec ?? null;
			if (message.kind === "cap-h264-unavailable")
				throw new Error(message.error ?? "Native H.264 unavailable");
			return;
		}
		if (!collecting || !(event.data instanceof ArrayBuffer)) return;
		if (nativeH264) {
			const packet = Buffer.from(event.data);
			if (packet.subarray(0, 8).toString() !== "CAPH2641") return;
			const sequence = Number(packet.readBigUInt64LE(8));
			if (lastH264Sequence !== null && sequence !== lastH264Sequence + 1)
				h264SequenceGaps++;
			lastH264Sequence = sequence;
			if (packet[16] === 1) h264Keyframes++;
		}
		frameTimes.push(performance.now());
		frameBytes += event.data.byteLength;
		if ((measureLosslessDelta || measureH264) && deltaPackets.length < 60) {
			deltaPackets.push(Buffer.from(event.data));
		}
	};
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("1080p frame socket timed out")),
			5000,
		);
		if (!frameSocket) return reject(new Error("Missing 1080p frame socket"));
		frameSocket.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		frameSocket.onerror = () => {
			clearTimeout(timer);
			reject(new Error("1080p frame socket failed"));
		};
	});
	const playback = await app.request(`/editor/sessions/${sessionId}/playback`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			frameNumber: 0,
			fps: playbackFps,
			resolutionBase: { x: 1920, y: 1080 },
		}),
	});
	assert.equal(playback.status, 204);
	await Bun.sleep(1000);
	collecting = true;
	const playbackResourceSamples = [];
	for (const second of [5, 10, 15, 20]) {
		await Bun.sleep(5000);
		const [rssMb, cpuPercent] = await Promise.all([
			nativeRssMb(native.pid),
			nativeCpuPercent(native.pid),
		]);
		playbackResourceSamples.push({ second, rssMb, cpuPercent });
	}
	collecting = false;
	const stopped = await app.request(`/editor/sessions/${sessionId}/playback`, {
		method: "DELETE",
		headers,
	});
	assert.equal(stopped.status, 204);
	const intervals = frameTimes
		.slice(1)
		.map((time, index) => time - (frameTimes[index] ?? time))
		.sort((a, b) => a - b);
	const frameIntervalP95Ms =
		intervals[Math.floor(intervals.length * 0.95)] ?? null;
	const firstRssMb = playbackResourceSamples[0]?.rssMb;
	const lastRssMb = playbackResourceSamples.at(-1)?.rssMb;
	assert.ok(
		frameTimes.length >= (playbackFps === 30 && !nativeH264 ? 540 : 2),
		"1080p playback delivered too few frames",
	);
	if (playbackFps === 30) {
		assert.ok(
			frameIntervalP95Ms !== null && frameIntervalP95Ms < 100,
			"1080p frame delivery stalled",
		);
	}
	assert.ok(
		firstRssMb !== null &&
			firstRssMb !== undefined &&
			lastRssMb !== null &&
			lastRssMb !== undefined &&
			lastRssMb - firstRssMb < 64,
		"1080p playback memory kept growing",
	);
	frameSocket.close();
	frameSocket = null;
	const losslessDelta = measureLosslessDelta
		? await losslessDeltaProbe(deltaPackets)
		: null;
	const h264Preview = measureH264
		? await h264PreviewProbe(deltaPackets, temporary)
		: null;
	const beforeBrowserMetricsResponse = await native.request("/metrics");
	assert.equal(beforeBrowserMetricsResponse.status, 200);
	const beforeBrowserFrameMetrics =
		(await beforeBrowserMetricsResponse.json()) as {
			h264Bytes: number;
			h264Frames: number;
		};
	browser = await browserEngine.launch({
		headless: true,
		...(browserEngine === chromium
			? { args: ["--enable-precise-memory-info"] }
			: {}),
	});
	const page = await browser.newPage({
		viewport: { width: 1920, height: 1080 },
	});
	const browserWarnings: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "warning" && message.text().includes("H.264"))
			browserWarnings.push(message.text());
	});
	await page.goto(`${base}/bench`);
	if (downloadMbps !== null) {
		const browserNetwork = await page.context().newCDPSession(page);
		await browserNetwork.send("Network.enable");
		await browserNetwork.send("Network.emulateNetworkConditions", {
			offline: false,
			latency: 50,
			downloadThroughput: (downloadMbps * 1_000_000) / 8,
			uploadThroughput: -1,
		});
	}
	const browserTicketsResponse = await app.request(
		`/editor/sessions/${sessionId}/sockets`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ origin: base }),
		},
	);
	assert.equal(browserTicketsResponse.status, 200);
	const browserTickets = (await browserTicketsResponse.json()) as {
		sockets: { frames: { url: string; ticket: string } };
	};
	await page.evaluate(async (credential) => {
		const modulePath = "/bench.js";
		const module = (await import(modulePath)) as {
			setEditorFrameSocketCredential: (value: {
				url: string;
				ticket: string;
			}) => void;
			createWS: (url: string) => WebSocket;
		};
		const canvas = document.getElementById(
			"bench-canvas",
		) as HTMLCanvasElement | null;
		const context = canvas?.getContext("2d", { alpha: false });
		if (!canvas || !context)
			throw new Error("Browser frame canvas unavailable");
		const state: BrowserFrameBenchmark = {
			collecting: false,
			frameTimes: [],
			paintTimes: [],
			frameNumbers: [],
			lastFrameNumber: null,
			webCodecsAvailable:
				isSecureContext &&
				typeof VideoDecoder !== "undefined" &&
				typeof EncodedVideoChunk !== "undefined",
			requestedModes: [],
			socketCloseCode: null,
			rawBytes: 0,
			longTasks: 0,
		};
		const browserWindow = window as typeof window & {
			capFrameBenchmark?: BrowserFrameBenchmark;
			capFrameSocket?: WebSocket;
			capExpectedPausedFrame?: number;
			capPausedFrame?: ArrayBuffer;
		};
		browserWindow.capFrameBenchmark = state;
		new PerformanceObserver((list) => {
			if (state.collecting) state.longTasks += list.getEntries().length;
		}).observe({ entryTypes: ["longtask"] });
		module.setEditorFrameSocketCredential(credential);
		const socket = module.createWS(credential.url);
		const nativeSend = socket.send.bind(socket);
		socket.send = (data) => {
			if (typeof data === "string") state.requestedModes.push(data);
			nativeSend(data);
		};
		socket.addEventListener("close", (event) => {
			state.socketCloseCode = event.code;
		});
		browserWindow.capFrameSocket = socket;
		socket.addEventListener("message", (event: MessageEvent<unknown>) => {
			if (!(event.data instanceof ArrayBuffer)) return;
			const paintedAt = performance.now();
			const footerOffset = event.data.byteLength - 24;
			const meta = new DataView(event.data, footerOffset, 24);
			const width = meta.getUint32(8, true);
			const height = meta.getUint32(4, true);
			state.lastFrameNumber = meta.getUint32(12, true);
			if (state.lastFrameNumber === browserWindow.capExpectedPausedFrame)
				browserWindow.capPausedFrame = event.data;
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}
			context.putImageData(
				new ImageData(
					new Uint8ClampedArray(event.data, 0, width * height * 4),
					width,
					height,
				),
				0,
				0,
			);
			if (state.collecting) {
				state.frameTimes.push(performance.now());
				state.paintTimes.push(performance.now() - paintedAt);
				state.frameNumbers.push(meta.getUint32(12, true));
				state.rawBytes += event.data.byteLength;
			}
		});
		await new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(
				() => reject(new Error("Browser frame socket timed out")),
				5000,
			);
			socket.addEventListener(
				"open",
				() => {
					window.clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			socket.addEventListener(
				"error",
				() => {
					window.clearTimeout(timer);
					reject(new Error("Browser frame socket failed"));
				},
				{ once: true },
			);
		});
	}, browserTickets.sockets.frames);
	const browserPlayback = await app.request(
		`/editor/sessions/${sessionId}/playback`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				frameNumber: 0,
				fps: playbackFps,
				resolutionBase: { x: 1920, y: 1080 },
			}),
		},
	);
	assert.equal(browserPlayback.status, 204);
	await Bun.sleep(1000);
	await page.evaluate(() => {
		const state = (
			window as typeof window & { capFrameBenchmark?: BrowserFrameBenchmark }
		).capFrameBenchmark;
		if (!state) throw new Error("Browser frame benchmark unavailable");
		state.collecting = true;
	});
	const browserResourceSamples = [];
	for (const second of [5, 10, 15, 20]) {
		await Bun.sleep(5000);
		if (seekDuringH264 && second === 10) {
			const frameNumber = 450 * playbackFps;
			const position = {
				frameNumber,
				fps: playbackFps,
				resolutionBase: { x: 1920, y: 1080 },
			};
			const moved = await app.request(`/editor/sessions/${sessionId}/seek`, {
				method: "PUT",
				headers,
				body: JSON.stringify(position),
			});
			assert.equal(moved.status, 204);
			try {
				await page.waitForFunction(
					(expected) =>
						(
							window as typeof window & {
								capFrameBenchmark?: BrowserFrameBenchmark;
							}
						).capFrameBenchmark?.frameNumbers.some(
							(frameNumber) => frameNumber >= expected,
						),
					frameNumber,
					{ timeout: 5000 },
				);
			} catch (error) {
				const browserState = await page.evaluate(
					() =>
						(
							window as typeof window & {
								capFrameBenchmark?: BrowserFrameBenchmark;
							}
						).capFrameBenchmark,
				);
				const metrics = await native.request("/metrics");
				throw new Error(
					`Live seek did not reach the browser: ${JSON.stringify({
						browserFrames: browserState?.frameTimes.length,
						lastFrameNumber: browserState?.lastFrameNumber,
						requestedModes: browserState?.requestedModes,
						relayDiagnostics,
						browserWarnings,
						nativeMetrics: await metrics.json(),
					})}`,
					{ cause: error },
				);
			}
		}
		browserResourceSamples.push(
			await page.evaluate((sampleSecond) => {
				const memory = (
					performance as Performance & {
						memory?: { usedJSHeapSize: number };
					}
				).memory;
				return {
					second: sampleSecond,
					jsHeapMb: memory
						? Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10
						: null,
				};
			}, second),
		);
	}
	const browserResult = await page.evaluate(() => {
		const browserWindow = window as typeof window & {
			capFrameBenchmark?: BrowserFrameBenchmark;
			capFrameSocket?: WebSocket;
		};
		const state = browserWindow.capFrameBenchmark;
		if (!state) throw new Error("Browser frame benchmark unavailable");
		state.collecting = false;
		return state;
	});
	const movingSamples: Array<{ frameNumber: number; png: string }> = [];
	if (measureMovingQuality) {
		assert.ok(nativeH264, "Moving quality requires native H.264 preview");
		for (let sample = 0; sample < 3; sample++) {
			await Bun.sleep(250);
			movingSamples.push(
				await page.evaluate(() => {
					const state = (
						window as typeof window & {
							capFrameBenchmark?: BrowserFrameBenchmark;
						}
					).capFrameBenchmark;
					const canvas = document.getElementById(
						"bench-canvas",
					) as HTMLCanvasElement | null;
					if (!canvas || state?.lastFrameNumber === null || !state)
						throw new Error("Moving frame sample was unavailable");
					return {
						frameNumber: state.lastFrameNumber,
						png: canvas.toDataURL("image/png"),
					};
				}),
			);
		}
	}
	const browserStopped = await app.request(
		`/editor/sessions/${sessionId}/playback`,
		{ method: "DELETE", headers },
	);
	assert.equal(browserStopped.status, 204);
	if (movingSamples.length > 0) await Bun.sleep(250);
	const movingQuality: Array<{
		frameNumber: number;
		psnrDb: number;
		meanAbsoluteError: number;
	}> = [];
	for (const sample of movingSamples) {
		const preview = await native.request("/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				frameNumber: sample.frameNumber,
				fps: playbackFps,
				resolutionBase: { x: 1920, y: 1080 },
			}),
		});
		assert.equal(preview.status, 200);
		const exact = Buffer.from(await preview.arrayBuffer());
		const pixelBytes = 1920 * 1080 * 4;
		assert.equal(exact.length, pixelBytes + 24);
		const browserPng = Buffer.from(
			sample.png.slice("data:image/png;base64,".length),
			"base64",
		);
		if (movingArtifactDirectory) {
			await mkdir(movingArtifactDirectory, { recursive: true });
			await Promise.all([
				writeFile(
					join(movingArtifactDirectory, `browser-${sample.frameNumber}.png`),
					browserPng,
				),
				writeFile(
					join(movingArtifactDirectory, `native-${sample.frameNumber}.png`),
					await sharp(exact.subarray(0, pixelBytes), {
						raw: { width: 1920, height: 1080, channels: 4 },
					})
						.png()
						.toBuffer(),
				),
			]);
		}
		const browserPixels = await sharp(browserPng)
			.ensureAlpha()
			.raw()
			.toBuffer();
		assert.equal(browserPixels.length, pixelBytes);
		let squaredError = 0;
		let absoluteError = 0;
		for (let offset = 0; offset < pixelBytes; offset += 4) {
			for (let channel = 0; channel < 3; channel++) {
				const difference =
					(browserPixels[offset + channel] ?? 0) -
					(exact[offset + channel] ?? 0);
				absoluteError += Math.abs(difference);
				squaredError += difference * difference;
			}
		}
		const channels = 1920 * 1080 * 3;
		const mse = squaredError / channels;
		movingQuality.push({
			frameNumber: sample.frameNumber,
			psnrDb:
				Math.round((mse === 0 ? 100 : 10 * Math.log10(255 ** 2 / mse)) * 10) /
				10,
			meanAbsoluteError: Math.round((absoluteError / channels) * 10) / 10,
		});
	}
	let pausedPreviewSha256: string | null = null;
	if (seekDuringH264) {
		await Bun.sleep(250);
		const pausedFrameNumber = 700 * playbackFps;
		await page.evaluate((frameNumber) => {
			(
				window as typeof window & { capExpectedPausedFrame?: number }
			).capExpectedPausedFrame = frameNumber;
		}, pausedFrameNumber);
		const preview = await native.request("/preview", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				frameNumber: pausedFrameNumber,
				fps: playbackFps,
				resolutionBase: { x: 1920, y: 1080 },
			}),
		});
		assert.equal(preview.status, 200);
		const nativeFrame = Buffer.from(await preview.arrayBuffer());
		const nativePixelBytes = 1920 * 1080 * 4;
		assert.equal(nativeFrame.length, nativePixelBytes + 24);
		assert.equal(nativeFrame.readUInt32LE(nativePixelBytes), 1920 * 4);
		pausedPreviewSha256 = createHash("sha256")
			.update(nativeFrame.subarray(0, nativePixelBytes))
			.digest("hex");
		try {
			await page.waitForFunction(
				(expected) =>
					(
						window as typeof window & {
							capFrameBenchmark?: BrowserFrameBenchmark;
						}
					).capFrameBenchmark?.lastFrameNumber === expected,
				pausedFrameNumber,
				{ timeout: 5000 },
			);
		} catch (error) {
			const browserState = await page.evaluate(
				() =>
					(
						window as typeof window & {
							capFrameBenchmark?: BrowserFrameBenchmark;
						}
					).capFrameBenchmark,
			);
			const metrics = await native.request("/metrics");
			throw new Error(
				`Paused preview did not reach the browser: ${JSON.stringify({
					lastFrameNumber: browserState?.lastFrameNumber,
					requestedModes: browserState?.requestedModes,
					relayDiagnostics,
					browserWarnings,
					nativeMetrics: await metrics.json(),
				})}`,
				{ cause: error },
			);
		}
		const browserPreviewSha256 = await page.evaluate(async () => {
			const browserWindow = window as typeof window & {
				capPausedFrame?: ArrayBuffer;
			};
			const frame = browserWindow.capPausedFrame;
			if (!frame) throw new Error("Paused browser preview was missing");
			const digest = await crypto.subtle.digest(
				"SHA-256",
				frame.slice(0, frame.byteLength - 24),
			);
			return Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
		});
		assert.equal(browserPreviewSha256, pausedPreviewSha256);
	}
	await page.evaluate(() => {
		(
			window as typeof window & { capFrameSocket?: WebSocket }
		).capFrameSocket?.close();
	});
	const browserFrameIntervals = browserResult.frameTimes
		.slice(1)
		.map((time, index) => time - (browserResult.frameTimes[index] ?? time))
		.sort((a, b) => a - b);
	const browserPaintTimes = browserResult.paintTimes.toSorted((a, b) => a - b);
	const browserIntervalP95Ms =
		browserFrameIntervals[Math.floor(browserFrameIntervals.length * 0.95)] ??
		null;
	const browserPaintP95Ms =
		browserPaintTimes[Math.floor(browserPaintTimes.length * 0.95)] ?? null;
	assert.ok(
		browserResult.frameTimes.length >=
			(nativeH264
				? playbackFps * 18
				: downloadMbps === null && playbackFps === 30
					? 540
					: 2),
		`1080p browser replay painted too few frames: ${JSON.stringify({
			frames: browserResult.frameTimes.length,
			modes: browserResult.requestedModes,
			relayDiagnostics,
			warnings: browserWarnings,
		})}`,
	);
	if (downloadMbps === null && playbackFps === 30) {
		assert.ok(
			browserIntervalP95Ms !== null && browserIntervalP95Ms < 100,
			"1080p browser replay stalled",
		);
	}
	assert.ok(
		browserPaintP95Ms !== null && browserPaintP95Ms < 16,
		"1080p browser painting blocked the main thread",
	);
	const browserHeapHalfwayMb = browserResourceSamples[1]?.jsHeapMb;
	const browserHeapFinalMb = browserResourceSamples.at(-1)?.jsHeapMb;
	assert.ok(
		browserHeapHalfwayMb === null ||
			browserHeapHalfwayMb === undefined ||
			browserHeapFinalMb === null ||
			browserHeapFinalMb === undefined ||
			browserHeapFinalMb - browserHeapHalfwayMb < 64,
		"1080p browser heap kept growing",
	);
	const rssAfterPlaybackMb = await nativeRssMb(native.pid);
	const metricsResponse = await native.request("/metrics");
	assert.equal(metricsResponse.status, 200);
	const frameMetrics = (await metricsResponse.json()) as {
		packedFrames: number;
		avgPackMs: number;
		rawBytes: number;
		sentBytes: number;
		h264Frames: number;
		h264Bytes: number;
	};
	assert.ok(frameMetrics.packedFrames >= (nativeH264 ? 540 : 1_080));
	assert.ok(frameMetrics.avgPackMs >= 0);
	assert.ok(frameMetrics.sentBytes > 0);
	assert.ok(frameMetrics.sentBytes < frameMetrics.rawBytes);
	if (nativeH264)
		assert.ok(
			frameMetrics.h264Frames >= playbackFps * 35,
			"1080p browser replay failed to use H.264 preview",
		);
	const estimatedRequestedFpsCompressedMbps = nativeH264
		? null
		: Math.round(
				((frameMetrics.sentBytes / frameMetrics.packedFrames) *
					playbackFps *
					8) /
					100_000,
			) / 10;
	const estimatedH264Mbps =
		frameMetrics.h264Frames > 0
			? Math.round(
					((frameMetrics.h264Bytes / frameMetrics.h264Frames) *
						playbackFps *
						8) /
						100_000,
				) / 10
			: null;
	const browserH264Bytes =
		frameMetrics.h264Bytes - beforeBrowserFrameMetrics.h264Bytes;
	const browserH264Frames =
		frameMetrics.h264Frames - beforeBrowserFrameMetrics.h264Frames;
	assert.ok(browserH264Bytes >= 0 && browserH264Frames >= 0);
	const estimatedBrowserH264Mbps =
		browserH264Frames > 0
			? Math.round(
					((browserH264Bytes / browserH264Frames) * playbackFps * 8) / 100_000,
				) / 10
			: null;
	process.stdout.write(
		`${JSON.stringify({
			resolution: "1920x1080",
			browserEngine: browserEngine.name(),
			downloadMbps,
			playbackFps,
			nativeH264,
			seekDuringH264,
			movingQuality,
			pausedPreviewSha256,
			h264Config,
			h264Keyframes,
			h264SequenceGaps,
			cameraResolution: "1280x720",
			clipSeconds: longSeconds,
			assetBytes: sizes.map((size) => size.size),
			prepareMs,
			seeks,
			seekMedianMs: sorted[Math.floor(sorted.length / 2)],
			seekP95Ms: sorted[Math.floor(sorted.length * 0.95)],
			rssBeforeMb,
			rssAfterSeeksMb,
			playbackFramesInTwentySeconds: frameTimes.length,
			playbackDeliveredFps: Math.round((frameTimes.length / 20) * 10) / 10,
			playbackFrameIntervalP95Ms: frameIntervalP95Ms,
			playbackBytes: frameBytes,
			playbackResourceSamples,
			browserFramesInTwentySeconds: browserResult.frameTimes.length,
			browserPaintedFps:
				Math.round((browserResult.frameTimes.length / 20) * 10) / 10,
			browserFrameIntervalP95Ms: browserIntervalP95Ms,
			browserPaintP95Ms,
			browserDecodedBytes: browserResult.rawBytes,
			frameMetrics,
			estimatedRequestedFpsCompressedMbps,
			estimatedH264Mbps,
			estimatedBrowserH264Mbps,
			browserH264Bytes,
			browserH264Frames,
			losslessDelta,
			h264Preview,
			browserLongTasks: browserResult.longTasks,
			browserWarnings,
			browserWebCodecsAvailable: browserResult.webCodecsAvailable,
			browserRequestedModes: browserResult.requestedModes,
			relayDiagnostics,
			browserSocketCloseCode: browserResult.socketCloseCode,
			browserResourceSamples,
			rssAfterPlaybackMb,
			workerRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
		})}\n`,
	);
} finally {
	if (sessionId) {
		await app.request(`/editor/sessions/${sessionId}`, {
			method: "DELETE",
			headers: { "x-media-server-secret": secret },
		});
	}
	frameSocket?.close();
	await browser?.close();
	socketServer?.stop(true);
	server?.stop(true);
	await rm(temporary, { recursive: true, force: true });
	if (previousSecret === undefined) {
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	} else {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
	}
	if (previousAllowHttp === undefined) {
		delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	} else {
		process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousAllowHttp;
	}
	if (previousPublicOrigin === undefined) {
		delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
	} else {
		process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = previousPublicOrigin;
	}
}
