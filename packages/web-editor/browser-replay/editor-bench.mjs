import { execFileSync } from "node:child_process";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);

const dist = resolve(option("dist", "../../../apps/web/public/editor"));
const fixtures = resolve(option("fixtures", "fixtures"));
const browserName = option("browser", "chromium");
const runs = Number(option("runs", "3"));
const slow = flag("slow");
const require = createRequire(
	resolve(option("playwright-from", process.cwd()), "package.json"),
);
const { chromium, firefox, webkit } = require("playwright");

if (flag("make-fixtures")) {
	mkdirSync(fixtures, { recursive: true });
	const ffmpeg = (...rest) =>
		execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...rest]);
	const fragmented = [
		"-movflags",
		"+frag_keyframe+empty_moov+default_base_moof",
	];
	ffmpeg(
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=1920x1080:rate=30,format=yuv420p",
		"-t",
		"60",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-g",
		"60",
		"-b:v",
		"6M",
		...fragmented,
		join(fixtures, "display.mp4"),
	);
	ffmpeg(
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=640x360:rate=30,format=yuv420p",
		"-t",
		"60",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-g",
		"60",
		"-b:v",
		"1M",
		...fragmented,
		join(fixtures, "camera.mp4"),
	);
	ffmpeg(
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=1920x1080:rate=30,format=yuv420p",
		"-t",
		"60",
		"-c:v",
		"libvpx",
		"-deadline",
		"realtime",
		"-cpu-used",
		"8",
		"-b:v",
		"6M",
		"-g",
		"60",
		join(fixtures, "display.webm"),
	);
	ffmpeg(
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=640x360:rate=30,format=yuv420p",
		"-t",
		"60",
		"-c:v",
		"libvpx",
		"-deadline",
		"realtime",
		"-cpu-used",
		"8",
		"-b:v",
		"1M",
		"-g",
		"60",
		join(fixtures, "camera.webm"),
	);
	ffmpeg(
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000",
		"-t",
		"60",
		"-c:a",
		"libopus",
		"-b:a",
		"64k",
		join(fixtures, "mic.webm"),
	);
}

const types = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".wasm": "application/wasm",
	".json": "application/json",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".jpg": "image/jpeg",
	".png": "image/png",
	".ttf": "font/ttf",
	".woff2": "font/woff2",
	".woff": "font/woff",
};

const format = browserName === "firefox" ? "webm" : "mp4";
const videoId = "fixture";

const mediaReads = [];
const compressible = new Set([
	".html",
	".js",
	".css",
	".wasm",
	".json",
	".ttf",
]);
const compressed = new Map();
function brotli(file) {
	let body = compressed.get(file);
	if (!body) {
		body = brotliCompressSync(readFileSync(file), {
			params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
		});
		compressed.set(file, body);
	}
	return body;
}

function sendFile(request, response, file) {
	if (file.startsWith(fixtures))
		mediaReads.push(
			`${file.slice(fixtures.length + 1)} ${request.headers.range ?? "all"}`,
		);
	if (!existsSync(file) || !statSync(file).isFile()) {
		response.writeHead(404).end();
		return;
	}
	const size = statSync(file).size;
	const headers = {
		"Content-Type": types[extname(file)] ?? "application/octet-stream",
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store",
	};
	if (
		file.startsWith(dist) &&
		compressible.has(extname(file)) &&
		/\bbr\b/.test(request.headers["accept-encoding"] ?? "")
	) {
		const body = brotli(file);
		response.writeHead(200, {
			...headers,
			"Content-Encoding": "br",
			"Content-Length": body.length,
			Vary: "Accept-Encoding",
		});
		response.end(body);
		return;
	}
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
	if (!range) {
		response.writeHead(200, { ...headers, "Content-Length": size });
		createReadStream(file).pipe(response);
		return;
	}
	const start = Number(range[1]);
	const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
	if (start >= size || end < start) {
		response
			.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` })
			.end();
		return;
	}
	response.writeHead(206, {
		...headers,
		"Content-Length": end - start + 1,
		"Content-Range": `bytes ${start}-${end}/${size}`,
	});
	createReadStream(file, { start, end }).pipe(response);
}

const hostPage = `<!doctype html><html><head><meta charset="utf-8"><title>Editor bench host</title>
<style>html,body{margin:0;background:#111}iframe{border:0;width:1440px;height:900px;display:block}</style></head>
<body><script type="module">
const iframe = document.createElement("iframe");
iframe.src = "/editor/index.html?videoId=${videoId}&perf=1";
window.__bench = { painted: null, failed: null, mounted: null, unhandled: [] };
addEventListener("message", (event) => {
	const data = event.data;
	if (data?.kind === "cap-editor-painted" && window.__bench.painted === null)
		window.__bench.painted = performance.now();
	if (data?.kind === "cap-editor-preview-failed") window.__bench.failed = data;
});
const results = {
	checkUpgradedAndUpdate: true,
	"tauri:webEditorSaveStatus": { state: "idle", exportId: null, progress: 0, playable: false, hlsUrl: null, error: null },
	"tauri:webEditorDefaultStyle": null,
	"tauri:webEditorStoredDesktopBackground": null,
	setProjectConfig: null,
	setPrettyName: null,
};
iframe.addEventListener("load", () => {
	const channel = new MessageChannel();
	channel.port1.onmessage = (event) => {
		const message = event.data;
		if (message.kind === "mount") {
			window.__bench.mounted = performance.now();
			return;
		}
		if (message.kind === "emit") {
			channel.port1.postMessage({ kind: "result", id: message.id, value: null });
			return;
		}
		if (message.name in results) {
			channel.port1.postMessage({ kind: "result", id: message.id, value: results[message.name] });
			return;
		}
		window.__bench.unhandled.push(message.name);
		channel.port1.postMessage({ kind: "error", id: message.id, error: "Not available in the bench host" });
	};
	iframe.contentWindow.postMessage(
		{ kind: "cap-editor-connect", version: 1, videoId: "${videoId}", captionsEnabled: true, userId: "bench", assetBase: "/asset?videoId=${videoId}", browserSessionId: "browser-${videoId}" },
		location.origin,
		[channel.port2],
	);
});
document.body.append(iframe);
</script></body></html>`;

function bootstrap(origin) {
	const expiresAt = Date.now() + 60 * 60 * 1000;
	return {
		videoId,
		sources: {
			videoId,
			title: "Bench recording",
			captionsEnabled: true,
			signedUrlExpiresAt: expiresAt,
			displayHasAudio: false,
			durationHint: 60,
			display: {
				url: `${origin}/fixtures/display.${format}`,
				contentType: `video/${format}`,
				fps: 30,
				size: statSync(join(fixtures, `display.${format}`)).size,
			},
			camera: {
				url: `${origin}/fixtures/camera.${format}`,
				contentType: `video/${format}`,
				fps: 30,
				offsetMs: 0,
				size: statSync(join(fixtures, `camera.${format}`)).size,
			},
			mic: {
				url: `${origin}/fixtures/mic.webm`,
				contentType: "audio/webm",
				offsetMs: 0,
				size: statSync(join(fixtures, "mic.webm")).size,
			},
		},
	};
}

const server = createServer((request, response) => {
	const url = new URL(request.url, "http://localhost");
	const origin = `http://${request.headers.host}`;
	if (url.pathname === "/" || url.pathname === "/host.html") {
		response.writeHead(200, { "Content-Type": "text/html" }).end(hostPage);
		return;
	}
	if (url.pathname === `/api/editor/videos/${videoId}/bootstrap`) {
		response
			.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			})
			.end(JSON.stringify(bootstrap(origin)));
		return;
	}
	if (url.pathname === "/api/editor/preferences/studio-sound") {
		response
			.writeHead(200, { "Content-Type": "application/json" })
			.end(JSON.stringify({ enabledByDefault: true, isolation: "balanced" }));
		return;
	}
	if (url.pathname.startsWith("/fixtures/")) {
		sendFile(request, response, join(fixtures, url.pathname.slice(10)));
		return;
	}
	if (url.pathname.startsWith("/editor/")) {
		const file = resolve(dist, url.pathname.slice(8));
		if (!file.startsWith(dist)) {
			response.writeHead(403).end();
			return;
		}
		sendFile(request, response, file);
		return;
	}
	response.writeHead(404).end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const launchers = {
	chromium: () => chromium.launch(),
	chrome: () =>
		chromium.launch({
			channel: "chrome",
			headless: !flag("headed"),
			args: [
				"--enable-unsafe-webgpu",
				"--enable-gpu",
				"--ignore-gpu-blocklist",
			],
		}),
	webkit: () => webkit.launch(),
	firefox: () => firefox.launch(),
};

const percentile = (values, p) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

const browser = await launchers[browserName]();
const results = [];
const warmup = flag("no-warmup") ? 0 : 1;
for (let run = -warmup; run < runs; run++) {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
	});
	const page = await context.newPage();
	if (slow && (browserName === "chromium" || browserName === "chrome")) {
		const cdp = await context.newCDPSession(page);
		await cdp.send("Network.enable");
		await cdp.send("Network.emulateNetworkConditions", {
			offline: false,
			latency: 150,
			downloadThroughput: (10 * 1024 * 1024) / 8,
			uploadThroughput: (2 * 1024 * 1024) / 8,
		});
	}
	const requests = [];
	const started = Date.now();
	page.on("request", (request) => {
		requests.push({ url: request.url(), at: Date.now() - started });
	});
	const sizes = new Map();
	page.on("response", async (response) => {
		const length = Number(response.headers()["content-length"] ?? 0);
		sizes.set(response.url(), (sizes.get(response.url()) ?? 0) + length);
	});
	await page.goto(`${origin}/host.html`);
	await page.waitForFunction(
		() => window.__bench.painted !== null || window.__bench.failed !== null,
		null,
		{ timeout: 180_000 },
	);
	const host = await page.evaluate(() => window.__bench);
	const paintedAt = host.painted;
	const frame = page.frames().find((f) => f.url().includes("/editor/"));
	const marks = await frame.evaluate(() => {
		const perf = window.__capEditorPerf;
		return perf ? { ...perf.marks } : null;
	});
	const navStart = await page.evaluate(() => performance.timeOrigin);
	const frameOrigin = await frame.evaluate(() => performance.timeOrigin);
	const beforePaint = requests.filter(
		(request) =>
			request.at <=
			(host.painted ?? Number.POSITIVE_INFINITY) + (navStart - started),
	);
	const gpu = await frame.evaluate(async () => {
		if (!("gpu" in navigator)) return "no navigator.gpu";
		try {
			const adapter = await navigator.gpu.requestAdapter();
			return adapter ? "webgpu" : "no adapter";
		} catch {
			return "webgpu error";
		}
	});

	let scrub = null;
	if (paintedAt !== null) {
		const timeline = await frame.$("[data-editor-timeline]");
		const box = timeline ? await timeline.boundingBox() : null;
		if (box) {
			const y = box.y + Math.min(60, box.height / 2);
			const x0 = box.x + 40;
			const x1 = box.x + box.width - 40;
			await page.mouse.move(x0, y);
			const spans = await frame.evaluate(
				async ({ x0, x1, y }) => {
					const perf = window.__capEditorPerf;
					perf?.reset();
					const target = document.elementFromPoint(x0, y);
					if (!target || !perf) return null;
					const seconds = 3;
					const started = performance.now();
					await new Promise((done) => {
						const tick = (now) => {
							const progress = (now - started) / (seconds * 1000);
							if (progress >= 1) return done();
							const sweep = progress < 0.5 ? progress * 2 : 2 - progress * 2;
							const clientX = x0 + (x1 - x0) * sweep;
							(document.elementFromPoint(clientX, y) ?? target).dispatchEvent(
								new MouseEvent("mousemove", {
									clientX,
									clientY: y,
									bubbles: true,
								}),
							);
							requestAnimationFrame(tick);
						};
						requestAnimationFrame(tick);
					});
					return {
						elapsed: (performance.now() - started) / 1000,
						drawn: (perf.spans["frame.draw"] ?? []).length,
						paused: perf.spans["frame.paused"] ?? [],
					};
				},
				{ x0, x1, y },
			);
			const elapsed = spans?.elapsed ?? 1;
			if (spans)
				scrub = {
					seconds: Number(elapsed.toFixed(2)),
					fps: Number((spans.drawn / elapsed).toFixed(1)),
					frameP50: Number((percentile(spans.paused, 0.5) ?? 0).toFixed(1)),
					frameP95: Number((percentile(spans.paused, 0.95) ?? 0).toFixed(1)),
				};
		}
	}
	const editorRequests = beforePaint.filter((r) => r.url.includes("/editor/"));
	if (run >= 0)
		results.push({
			run,
			firstFrameMs: paintedAt === null ? null : Math.round(paintedAt),
			editorMarks: marks
				? Object.fromEntries(
						Object.entries(marks).map(([k, v]) => [
							k,
							Math.round(v + frameOrigin - navStart),
						]),
					)
				: null,
			failed: host.failed,
			requestsBeforeFirstFrame: beforePaint.length,
			editorAssetRequestsBeforeFirstFrame: editorRequests.length,
			editorAssets:
				run === 0
					? editorRequests.map(
							(r) => `${r.at}ms ${r.url.replace(/^.*\/editor\//, "")}`,
						)
					: undefined,
			editorAssetBytesBeforeFirstFrame: editorRequests.reduce(
				(total, r) => total + (sizes.get(r.url) ?? 0),
				0,
			),
			unhandled: [...new Set(host.unhandled)],
			mediaReads: flag("log-media") ? mediaReads.splice(0) : undefined,
			gpu,
			scrub,
		});
	await context.close();
}
await browser.close();
server.close();
console.log(
	JSON.stringify({ browser: browserName, slow, dist, results }, null, 1),
);
