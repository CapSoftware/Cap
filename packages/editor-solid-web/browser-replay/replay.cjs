const fs = require("node:fs");
const path = require("node:path");
const { chromium, firefox, webkit } = require("playwright");

const browserName = process.argv[2];
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error("Choose chromium, firefox, or webkit");

const output = path.join(__dirname, "out");
const origin = "http://localhost:18999";
const format = browserName === "firefox" ? "webm" : "mp4";
const contentType = format === "webm" ? "video/webm" : "video/mp4";
const screen = fs.readFileSync(path.join(__dirname, `screen.${format}`));
const camera = fs.readFileSync(path.join(__dirname, `camera.${format}`));

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function fulfillMedia(route, body) {
	const range = /^bytes=(\d+)-(\d*)$/.exec(
		route.request().headers().range ?? "",
	);
	const headers = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers": "Content-Range",
		"Accept-Ranges": "bytes",
	};
	if (!range) {
		await route.fulfill({ status: 200, contentType, headers, body });
		return;
	}
	const start = Number(range[1]);
	const end = range[2]
		? Math.min(Number(range[2]), body.length - 1)
		: body.length - 1;
	if (start >= body.length || end < start) {
		await route.fulfill({
			status: 416,
			contentType,
			headers: { ...headers, "Content-Range": `bytes */${body.length}` },
		});
		return;
	}
	await route.fulfill({
		status: 206,
		contentType,
		headers: {
			...headers,
			"Content-Range": `bytes ${start}-${end}/${body.length}`,
		},
		body: body.subarray(start, end + 1),
	});
}

async function replay(forceWebGl, forceWebGpu = false) {
	const browser = await browserType.launch({
		headless: process.env.CAP_REPLAY_HEADED !== "1",
		timeout: 30_000,
		...(forceWebGpu ? { args: ["--enable-unsafe-webgpu"] } : {}),
		...(browserName === "firefox" && process.env.CAP_REPLAY_HEADED === "1"
			? {
					firefoxUserPrefs: {
						"webgl.force-enabled": true,
						"webgl.forbid-software": false,
					},
				}
			: {}),
	});
	try {
		const page = await browser.newPage({
			viewport: { width: 1280, height: 800 },
		});
		const pageErrors = [];
		const consoleErrors = [];
		const workerRequests = [];
		let replayStage = "browser page loading";
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text());
			if (
				message.text().startsWith("Cap replay stage:") ||
				message.text().startsWith("Cap renderer stage:") ||
				message.text().startsWith("Cap WebGL query:")
			) {
				replayStage = message.text();
				console.log(replayStage);
			}
		});
		await page.addInitScript(() => {
			window.CapBrowserRendererTrace = true;
			window.CapBrowserGpuErrors = [];
			if (typeof GPUAdapter === "undefined") return;
			const requestDevice = GPUAdapter.prototype.requestDevice;
			GPUAdapter.prototype.requestDevice = async function (...args) {
				const device = await requestDevice.apply(this, args);
				device.addEventListener("uncapturederror", (event) => {
					if (window.CapBrowserGpuErrors.length < 8) {
						window.CapBrowserGpuErrors.push(event.error.message);
					}
				});
				return device;
			};
		});
		await page.addInitScript(() => {
			const getContext = HTMLCanvasElement.prototype.getContext;
			HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
				const result = getContext.call(this, kind, ...args);
				if (kind === "webgl2" || kind === "webgpu") {
					console.info(
						`Cap replay stage: canvas ${kind} context ${result ? "ready" : "unavailable"}`,
					);
				}
				return result;
			};
			for (const name of [
				"getSupportedExtensions",
				"getExtension",
				"getParameter",
				"getInternalformatParameter",
				"getShaderPrecisionFormat",
			]) {
				const method = WebGL2RenderingContext.prototype[name];
				if (typeof method !== "function") continue;
				WebGL2RenderingContext.prototype[name] = function (...args) {
					console.info(`Cap WebGL query: ${name} ${args.join(",")}`);
					const value = method.apply(this, args);
					console.info(`Cap WebGL query: ${name} returned`);
					return value;
				};
			}
			if (!navigator.gpu) return;
			const gpuPrototype = Object.getPrototypeOf(navigator.gpu);
			const requestAdapter = gpuPrototype.requestAdapter;
			if (typeof requestAdapter !== "function") return;
			gpuPrototype.requestAdapter = async function (...args) {
				console.info("Cap replay stage: WebGPU adapter requested");
				const adapter = await requestAdapter.apply(this, args);
				console.info(
					`Cap replay stage: WebGPU adapter ${adapter ? "ready" : "unavailable"}`,
				);
				return adapter;
			};
		});
		page.on("request", (request) => {
			if (request.url().includes("/api/editor/sessions/")) {
				workerRequests.push(request.url());
			}
		});
		if (forceWebGl) {
			await page.addInitScript(() => {
				Object.defineProperty(navigator, "gpu", {
					configurable: true,
					value: undefined,
				});
			});
		}
		await page.route(`${origin}/**`, async (route) => {
			const pathname = new URL(route.request().url()).pathname;
			if (pathname === "/api/editor/videos/fixture/bootstrap") {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						videoId: "fixture",
						sources: {
							videoId: "fixture",
							title: "Paired browser compositor fixture",
							captionsEnabled: false,
							signedUrlExpiresAt: Date.now() + 20 * 60_000,
							display: {
								url: `${origin}/screen.${format}`,
								contentType,
								fps: 30,
							},
							camera: {
								url: `${origin}/camera.${format}`,
								contentType,
								fps: 30,
								offsetMs: 0,
							},
						},
					}),
				});
				return;
			}
			if (pathname === `/screen.${format}`) {
				await fulfillMedia(route, screen);
				return;
			}
			if (pathname === `/camera.${format}`) {
				await fulfillMedia(route, camera);
				return;
			}
			if (pathname === "/favicon.ico") {
				await route.fulfill({ status: 204 });
				return;
			}
			const relative =
				pathname === "/browser-replay/"
					? "index.html"
					: pathname.replace(/^\/browser-replay\//, "");
			const file = path.resolve(output, relative);
			if (
				!file.startsWith(`${output}${path.sep}`) &&
				file !== path.join(output, "index.html")
			) {
				await route.fulfill({ status: 404 });
				return;
			}
			const type = file.endsWith(".wasm")
				? "application/wasm"
				: file.endsWith(".js")
					? "text/javascript"
					: file.endsWith(".css")
						? "text/css"
						: "text/html";
			await route.fulfill({
				status: 200,
				contentType: type,
				body: fs.readFileSync(file),
			});
		});
		await page.goto(`${origin}/browser-replay/`);
		replayStage = "browser page loaded";
		await page.waitForFunction(
			() => Boolean(window.CapBrowserLocalPlayback),
			null,
			{
				timeout: 30_000,
			},
		);
		let replayTimer;
		const result = await Promise.race([
			page.evaluate(async () => {
				console.info(
					`Cap replay stage: capabilities WebGPU=${Boolean(navigator.gpu)} WebGL2=${Boolean(document.createElement("canvas").getContext("webgl2"))}`,
				);
				console.info("Cap replay stage: creating local renderer");
				const started = performance.now();
				const canvas = document.createElement("canvas");
				canvas.style.cssText = "width:640px;height:360px";
				document.body.append(canvas);
				const frames = [];
				const errors = [];
				let playback;
				try {
					playback = await window.CapBrowserLocalPlayback.create(
						"fixture",
						canvas,
						0,
						0,
						(frame) => frames.push(frame),
						(error) => errors.push(error.message),
					);
					console.info("Cap replay stage: local renderer created");
				} catch (error) {
					const probe = document.createElement("canvas");
					const mediaProbe = await new Promise((resolve) => {
						const video = document.createElement("video");
						const events = [];
						video.muted = true;
						video.playsInline = true;
						video.crossOrigin = "anonymous";
						video.src = "/screen.webm";
						document.body.append(video);
						const finish = () => {
							window.clearTimeout(timer);
							const state = {
								events,
								readyState: video.readyState,
								networkState: video.networkState,
								width: video.videoWidth,
								height: video.videoHeight,
								duration: video.duration,
								error: video.error?.code ?? null,
							};
							video.remove();
							resolve(state);
						};
						video.addEventListener("loadedmetadata", () =>
							events.push("loadedmetadata"),
						);
						video.addEventListener(
							"loadeddata",
							() => {
								events.push("loadeddata");
								finish();
							},
							{ once: true },
						);
						video.addEventListener(
							"error",
							() => {
								events.push("error");
								finish();
							},
							{ once: true },
						);
						const timer = window.setTimeout(() => {
							events.push("timeout");
							finish();
						}, 3_000);
						video.load();
					});
					return {
						fatal: {
							error: String(error),
							type: typeof error,
							message: error?.message ?? null,
							stack: error?.stack ?? null,
							mediaProbe,
							capabilities: {
								webgpu: Boolean(navigator.gpu),
								webgl2: Boolean(probe.getContext("webgl2")),
								webm: document
									.createElement("video")
									.canPlayType('video/webm; codecs="vp8"'),
							},
						},
					};
				}
				try {
					const firstFrameMs = performance.now() - started;
					const backend = playback.canvas.renderer.backend;
					const snapshot = async () => {
						if (/webgpu/i.test(backend)) {
							return await playback.canvas.renderer.snapshot_rgba();
						}
						const target = document.createElement("canvas");
						if (!playback.drawLatestFrameToCanvas(target)) {
							throw new Error("GPU frame could not be inspected");
						}
						const context = target.getContext("2d", {
							willReadFrequently: true,
						});
						if (!context)
							throw new Error("GPU frame inspection is unavailable");
						return context.getImageData(0, 0, target.width, target.height).data;
					};
					const differentPixels = (first, second) => {
						if (first.length !== second.length) {
							throw new Error("GPU frame dimensions changed unexpectedly");
						}
						let count = 0;
						for (let index = 0; index < first.length; index += 4) {
							if (
								Math.abs(first[index] - second[index]) > 8 ||
								Math.abs(first[index + 1] - second[index + 1]) > 8 ||
								Math.abs(first[index + 2] - second[index + 2]) > 8
							) {
								count++;
							}
						}
						return count;
					};
					const withCamera = await snapshot();
					console.info("Cap replay stage: first GPU frame inspected");
					const config = JSON.parse(
						playback.module.default_project_config_json(),
					);
					config.camera.hide = true;
					await playback.setConfig(config);
					console.info("Cap replay stage: camera visibility updated");
					const withoutCamera = await snapshot();
					const changedPixels = differentPixels(withCamera, withoutCamera);
					config.camera.hide = false;
					await playback.setConfig(config);
					const seekStarted = performance.now();
					await playback.seek(0.75);
					console.info("Cap replay stage: first seek completed");
					const seekMs = performance.now() - seekStarted;
					const returnStarted = performance.now();
					await playback.seek(0);
					console.info("Cap replay stage: return seek completed");
					const startChangedPixels = differentPixels(
						withCamera,
						await snapshot(),
					);
					console.info("Cap replay stage: first frame compared");
					const returnToStartMs = performance.now() - returnStarted;
					await playback.seek(0.75);
					const beforePlay = frames.length;
					playback.play();
					await new Promise((resolve) => setTimeout(resolve, 850));
					console.info("Cap replay stage: playback interval completed");
					playback.pause();
					const videos = Array.from(document.querySelectorAll("video")).map(
						(video) => [video.videoWidth, video.videoHeight],
					);
					return {
						backend,
						firstFrameMs,
						seekMs,
						returnToStartMs,
						changedPixels,
						startChangedPixels,
						playedFrames: frames.length - beforePlay,
						videos,
						width: canvas.width,
						height: canvas.height,
						errors,
					};
				} finally {
					playback.dispose();
				}
			}),
			new Promise((_, reject) => {
				replayTimer = setTimeout(
					() => reject(new Error(`Browser replay stalled at ${replayStage}`)),
					45_000,
				);
			}),
		]).finally(() => clearTimeout(replayTimer));
		if (result.fatal) {
			throw new Error(
				JSON.stringify({
					browser: browserName,
					forceWebGl,
					forceWebGpu,
					...result.fatal,
					pageErrors,
					consoleErrors,
				}),
			);
		}
		const gpuErrors = await page.evaluate(
			() => window.CapBrowserGpuErrors ?? [],
		);
		assert(gpuErrors.length === 0, `GPU errors: ${gpuErrors.join(", ")}`);
		assert(
			result.errors.length === 0,
			`Playback errors: ${result.errors.join(", ")}`,
		);
		assert(pageErrors.length === 0, `Page errors: ${pageErrors.join(", ")}`);
		assert(
			workerRequests.length === 0,
			"Browser preview allocated a native worker",
		);
		assert(
			result.changedPixels > 1000,
			"Camera visibility did not change the GPU frame",
		);
		assert(
			result.startChangedPixels < 100,
			"Returning to the start did not reproduce the first GPU frame",
		);
		assert(result.playedFrames >= 2, "Local playback did not advance");
		assert(
			result.videos.some(([width, height]) => width === 640 && height === 360),
			"Screen clip did not decode",
		);
		assert(
			result.videos.some(([width, height]) => width === 320 && height === 180),
			"Camera clip did not decode",
		);
		if (forceWebGl)
			assert(/gl/i.test(result.backend), "WebGL fallback was not selected");
		if (forceWebGpu)
			assert(/webgpu/i.test(result.backend), "WebGPU path was not selected");
		console.log(
			JSON.stringify({
				browser: browserName,
				forceWebGl,
				forceWebGpu,
				...result,
			}),
		);
	} finally {
		await browser.close();
	}
}

async function main() {
	const modes =
		process.env.CAP_REPLAY_REQUIRE_WEBGPU === "1"
			? [[false, true]]
			: [
					[false, false],
					[true, false],
				];
	let failed = false;
	for (const [forceWebGl, forceWebGpu] of modes) {
		try {
			await replay(forceWebGl, forceWebGpu);
		} catch (error) {
			console.error(error);
			failed = true;
		}
	}
	if (failed) throw new Error("Browser compositor replay failed");
}

main().catch((error) => {
	console.error(error.stack ?? String(error));
	process.exitCode = 1;
});
