import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const DESKTOP_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "../..");
const DEFAULT_RECORDING =
	"/tmp/cap-performance-fixtures/reference-recording.cap";
const CHROME_PATH =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function parseArgs(argv) {
	const options = {
		recordingPath: DEFAULT_RECORDING,
		fps: 60,
		frames: 300,
		resolution: "half",
		startupDelayMs: 5000,
		allowNonWebGPU: false,
		keepTemp: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		if (token === "--") continue;
		if (token === "--allow-non-webgpu") {
			options.allowNonWebGPU = true;
			continue;
		}
		if (token === "--keep-temp") {
			options.keepTemp = true;
			continue;
		}

		const rawValue = token.includes("=")
			? token.slice(token.indexOf("=") + 1)
			: argv[index + 1];
		if (!token.includes("=")) index++;

		if (token.startsWith("--recording-path")) options.recordingPath = rawValue;
		if (token.startsWith("--fps")) options.fps = Number(rawValue);
		if (token.startsWith("--frames")) options.frames = Number(rawValue);
		if (token.startsWith("--resolution")) options.resolution = rawValue;
		if (token.startsWith("--startup-delay-ms"))
			options.startupDelayMs = Number(rawValue);
	}

	return options;
}

async function findFreePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}

async function buildHarness(tempDir) {
	const socketPath = path
		.resolve(DESKTOP_ROOT, "src/utils/socket.ts")
		.replaceAll(path.sep, "/");
	const entryPath = path.join(tempDir, "entry.ts");

	writeFileSync(
		entryPath,
		`import { createImageDataWS, getFpsStats } from "${socketPath}";

const params = new URLSearchParams(window.location.search);
const wsUrl = params.get("ws");
if (!wsUrl) throw new Error("Missing ws query param");

const canvas = document.getElementById("canvas");
const status = document.getElementById("status");
const samples = [];
let frameNotifications = 0;
let latestFrame = null;
let lastRequestFrameCount = 0;

const [ws, isConnected, isWorkerReady, controls] = createImageDataWS(
	wsUrl,
	(data) => {
		frameNotifications++;
		latestFrame = {
			width: data.width,
			height: data.height,
			hasBitmap: Boolean(data.bitmap),
		};
	},
	() => {
		lastRequestFrameCount++;
	},
);

controls.initDirectCanvas(canvas);

function summarizeSamples(sampleSet) {
	if (sampleSet.length === 0) return null;
	const average = (field) =>
		sampleSet.reduce((sum, sample) => sum + sample.stats[field], 0) /
		sampleSet.length;
	const maximum = (field) =>
		Math.max(...sampleSet.map((sample) => sample.stats[field]));
	const sum = (field) =>
		sampleSet.reduce((total, sample) => total + sample.stats[field], 0);
	return {
		sampleCount: sampleSet.length,
		avgFps: average("fps"),
		avgRenderFps: average("renderFps"),
		avgMbPerSec: average("mbPerSec"),
		avgFrameMs: average("avgFrameMs"),
		maxFrameMs: maximum("maxFrameMs"),
		avgRenderMs: average("avgRenderMs"),
		maxRenderMs: maximum("maxRenderMs"),
		avgUploadMs: average("avgUploadMs"),
		maxUploadMs: maximum("maxUploadMs"),
		avgReceiveToDisplayMs: average("avgReceiveToDisplayMs"),
		maxReceiveToDisplayMs: maximum("maxReceiveToDisplayMs"),
		sharedBufferWrites: sum("sharedBufferWrites"),
		sharedBufferFallbacks: sum("sharedBufferFallbacks"),
		frameCount: sum("frameCount"),
		renderCount: sum("renderCount"),
		uploadCount: sum("uploadCount"),
		receiveToDisplayCount: sum("receiveToDisplayCount"),
		transportModes: [...new Set(sampleSet.map((sample) => sample.stats.transportMode))],
	};
}

function snapshot() {
	const stats = getFpsStats();
	const sample = {
		atMs: performance.now(),
		connected: isConnected(),
		workerReady: isWorkerReady(),
		frameNotifications,
		lastRequestFrameCount,
		latestFrame,
		stats,
	};
	samples.push(sample);
	if (status) status.textContent = JSON.stringify(sample, null, 2);
	return sample;
}

const interval = window.setInterval(snapshot, 250);
window.__capDisplayBenchmarkResult = () => {
	const resultSamples = samples.filter((sample) => sample.stats);
	const stableSamples = resultSamples.filter(
		(sample) => sample.stats.windowMs >= 500 && sample.stats.renderCount >= 15,
	);
	const summarizedSamples =
		stableSamples.length > 0 ? stableSamples : resultSamples;
	const best = resultSamples.reduce(
		(current, sample) =>
			!current || sample.stats.renderFps > current.stats.renderFps
				? sample
				: current,
		null,
	);
	const mostFrames = resultSamples.reduce(
		(current, sample) =>
			!current || sample.frameNotifications > current.frameNotifications
				? sample
				: current,
		null,
	);
	return {
		best,
		mostFrames,
		lastWithStats: resultSamples.at(-1) ?? null,
		aggregate: summarizeSamples(summarizedSamples),
		stableSampleCount: stableSamples.length,
		latest: samples.at(-1) ?? null,
		sampleCount: samples.length,
		frameNotifications,
		lastRequestFrameCount,
		readyState: ws.readyState,
	};
};
window.__capDisplayBenchmarkDispose = () => {
	window.clearInterval(interval);
	controls.dispose();
};
window.__capDisplayBenchmarkReady = true;
snapshot();
`,
	);

	await build({
		root: tempDir,
		configFile: false,
		base: "./",
		logLevel: "warn",
		build: {
			outDir: "dist",
			emptyOutDir: true,
			target: "esnext",
			lib: {
				entry: entryPath,
				formats: ["es"],
				fileName: "entry",
			},
		},
		server: {
			fs: {
				allow: [DESKTOP_ROOT, tempDir],
			},
		},
	});

	writeFileSync(
		path.join(tempDir, "dist/index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><title>Cap Display Benchmark</title><style>html,body{margin:0;background:#111;color:#eee;font:12px system-ui}canvas{width:960px;height:540px;display:block}</style></head><body><canvas id="canvas"></canvas><pre id="status"></pre><script type="module" src="./entry.mjs"></script></body></html>`,
	);

	return path.join(tempDir, "dist/index.html");
}

function spawnRustBenchmark(options) {
	const args = [
		"run",
		"-p",
		"cap-desktop",
		"--example",
		"desktop-display-transport-benchmark",
		"--",
		"--recording-path",
		options.recordingPath,
		"--fps",
		String(options.fps),
		"--frames",
		String(options.frames),
		"--resolution",
		options.resolution,
		"--startup-delay-ms",
		String(options.startupDelayMs),
	];
	const child = spawn("cargo", args, {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let buffer = "";
	let wsUrlResolve;
	let wsUrlReject;
	const wsUrlPromise = new Promise((resolve, reject) => {
		wsUrlResolve = resolve;
		wsUrlReject = reject;
	});
	const outputLines = [];

	function handleOutput(chunk, streamName) {
		const text = chunk.toString();
		process[streamName].write(text);
		buffer += text;
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line) outputLines.push(line);
			const match = line.match(/DISPLAY_WS_URL=(ws:\/\/[^\s]+)/);
			if (match) wsUrlResolve(match[1]);
			newlineIndex = buffer.indexOf("\n");
		}
	}

	child.stdout.on("data", (chunk) => handleOutput(chunk, "stdout"));
	child.stderr.on("data", (chunk) => handleOutput(chunk, "stderr"));
	child.on("error", wsUrlReject);

	const exitPromise = new Promise((resolve, reject) => {
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve({ outputLines });
			} else {
				reject(new Error(`Rust benchmark exited with ${code ?? signal}`));
			}
		});
	});

	return { child, wsUrlPromise, exitPromise };
}

function spawnChrome(debuggingPort, tempDir) {
	const child = spawn(
		CHROME_PATH,
		[
			`--user-data-dir=${path.join(tempDir, "chrome-profile")}`,
			`--remote-debugging-port=${debuggingPort}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-extensions",
			"--allow-file-access-from-files",
			"--enable-unsafe-webgpu",
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	child.stderr.on("data", (chunk) => process.stderr.write(chunk));
	return child;
}

async function waitForPage(debuggingPort, timeoutMs = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${debuggingPort}/json/list`,
			);
			const targets = await response.json();
			const page = targets.find(
				(target) => target.type === "page" && target.webSocketDebuggerUrl,
			);
			if (page) return page;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Timed out waiting for Chrome page target");
}

async function connectCdp(wsUrl) {
	const socket = new WebSocket(wsUrl);
	const pending = new Map();
	const eventHandlers = new Map();
	let nextId = 1;

	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});

	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (!message.id) {
			const handlers = eventHandlers.get(message.method);
			if (handlers) {
				for (const handler of handlers) handler(message.params);
			}
			return;
		}
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		if (message.error) {
			entry.reject(new Error(JSON.stringify(message.error)));
		} else {
			entry.resolve(message.result);
		}
	});

	return {
		send(method, params = {}, timeoutMs = 10000) {
			const id = nextId++;
			socket.send(JSON.stringify({ id, method, params }));
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Timed out waiting for ${method}`));
				}, timeoutMs);
				pending.set(id, {
					resolve(value) {
						clearTimeout(timer);
						resolve(value);
					},
					reject(error) {
						clearTimeout(timer);
						reject(error);
					},
				});
			});
		},
		on(method, handler) {
			const handlers = eventHandlers.get(method) ?? new Set();
			handlers.add(handler);
			eventHandlers.set(method, handlers);
		},
		off(method, handler) {
			const handlers = eventHandlers.get(method);
			if (!handlers) return;
			handlers.delete(handler);
			if (handlers.size === 0) eventHandlers.delete(method);
		},
		close() {
			socket.close();
		},
	};
}

function waitForCdpEvent(cdp, method, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cdp.off(method, handler);
			reject(new Error(`Timed out waiting for ${method}`));
		}, timeoutMs);
		function handler(params) {
			clearTimeout(timer);
			cdp.off(method, handler);
			resolve(params);
		}
		cdp.on(method, handler);
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		sleep(3000),
	]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await Promise.race([
			new Promise((resolve) => child.once("exit", resolve)),
			sleep(1000),
		]);
	}
}

async function removeTempDir(tempDir) {
	let lastError = null;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			rmSync(tempDir, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			await sleep(250);
		}
	}
	if (lastError) {
		console.error(`Failed to remove temp dir ${tempDir}: ${lastError.message}`);
	}
}

async function waitForHarnessReady(cdp) {
	const started = Date.now();
	while (Date.now() - started < 10000) {
		const result = await cdp.send("Runtime.evaluate", {
			expression: "Boolean(window.__capDisplayBenchmarkReady)",
			returnByValue: true,
		});
		if (result.result.value) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Timed out waiting for display benchmark harness");
}

function assertResult(result, options) {
	const displayStats = result.mostFrames?.stats ?? result.lastWithStats?.stats;
	if (!displayStats) {
		throw new Error("No desktop display stats captured");
	}
	if (result.frameNotifications <= 0) {
		throw new Error("No displayed frame notifications captured");
	}
	const sawWebGPU =
		displayStats.transportMode === "webgpu" ||
		result.aggregate?.transportModes?.includes("webgpu");
	if (!options.allowNonWebGPU && !sawWebGPU) {
		throw new Error(
			`Expected WebGPU transport, saw ${displayStats.transportMode}`,
		);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const tempDir = mkdtempSync(path.join(tmpdir(), "cap-display-transport-"));
	let chrome = null;
	let rust = null;
	let cdp = null;

	try {
		const indexPath = await buildHarness(tempDir);
		rust = spawnRustBenchmark(options);
		const wsUrl = await rust.wsUrlPromise;
		const debuggingPort = await findFreePort();
		const pageUrl = `${pathToFileURL(indexPath).href}?ws=${encodeURIComponent(wsUrl)}`;
		chrome = spawnChrome(debuggingPort, tempDir);
		const page = await waitForPage(debuggingPort);
		cdp = await connectCdp(page.webSocketDebuggerUrl);
		const runtimeIssues = [];
		cdp.on("Runtime.exceptionThrown", (params) => {
			runtimeIssues.push(params.exceptionDetails?.text ?? "Runtime exception");
		});
		cdp.on("Runtime.consoleAPICalled", (params) => {
			const text = params.args
				?.map((arg) => arg.value ?? arg.description ?? "")
				.join(" ");
			if (text) runtimeIssues.push(`${params.type}: ${text}`);
		});
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");
		const loadPromise = waitForCdpEvent(cdp, "Page.loadEventFired").catch(
			() => null,
		);
		await cdp.send("Page.navigate", { url: pageUrl });
		await loadPromise;
		try {
			await waitForHarnessReady(cdp);
		} catch (error) {
			const snapshot = await cdp.send("Runtime.evaluate", {
				expression:
					"({ href: location.href, body: document.body?.innerText ?? null, ready: Boolean(window.__capDisplayBenchmarkReady) })",
				returnByValue: true,
			});
			throw new Error(
				`${error.message}; page=${JSON.stringify(snapshot.result.value)}; runtime=${JSON.stringify(runtimeIssues)}`,
			);
		}
		await rust.exitPromise;
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const evaluation = await cdp.send("Runtime.evaluate", {
			expression: "window.__capDisplayBenchmarkResult()",
			returnByValue: true,
		});
		const result = evaluation.result.value;
		assertResult(result, options);
		console.log(`DISPLAY_BROWSER_STATS=${JSON.stringify(result)}`);
		await cdp.send("Runtime.evaluate", {
			expression: "window.__capDisplayBenchmarkDispose()",
		});
	} finally {
		if (cdp) cdp.close();
		await stopProcess(chrome);
		await stopProcess(rust?.child);
		if (!options.keepTemp) {
			await removeTempDir(tempDir);
		} else {
			console.log(`DISPLAY_BENCHMARK_TEMP=${tempDir}`);
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
