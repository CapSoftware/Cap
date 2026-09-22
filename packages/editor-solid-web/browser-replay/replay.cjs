const fs = require("node:fs");
const path = require("node:path");
const { chromium, firefox, webkit } = require("playwright");
const sharp = require("sharp");

const browserName = process.argv[2];
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error("Choose chromium, firefox, or webkit");

const output = path.join(__dirname, "out");
const origin = "http://localhost:18999";
const defaultFormat = browserName === "firefox" ? "webm" : "mp4";
const indexed = process.env.CAP_REPLAY_INDEXED === "1";
const simulateFailedProbe =
	process.env.CAP_REPLAY_SIMULATE_FAILED_PROBE === "1";
const fixturePrefix = indexed ? "indexed-" : "";

function media(file) {
	const format = path.extname(file).slice(1).toLowerCase();
	if (format !== "mp4" && format !== "webm") {
		throw new Error("Replay media must be an MP4 or WebM file");
	}
	return {
		format,
		contentType: format === "webm" ? "video/webm" : "video/mp4",
		body: fs.readFileSync(file),
	};
}

const screen = media(
	process.env.CAP_REPLAY_SCREEN_FILE ||
		path.join(__dirname, `${fixturePrefix}screen.${defaultFormat}`),
);
const camera = media(
	process.env.CAP_REPLAY_CAMERA_FILE ||
		path.join(__dirname, `${fixturePrefix}camera.${defaultFormat}`),
);
const expectedScreenWidth = Number(process.env.CAP_REPLAY_SCREEN_WIDTH || 640);
const expectedScreenHeight = Number(
	process.env.CAP_REPLAY_SCREEN_HEIGHT || 360,
);
const expectedCameraWidth = Number(process.env.CAP_REPLAY_CAMERA_WIDTH || 320);
const expectedCameraHeight = Number(
	process.env.CAP_REPLAY_CAMERA_HEIGHT || 180,
);

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function fulfillMedia(route, asset) {
	const range = /^bytes=(\d+)-(\d*)$/.exec(
		route.request().headers().range ?? "",
	);
	const headers = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers": "Content-Range",
		"Accept-Ranges": "bytes",
	};
	if (!range) {
		await route.fulfill({
			status: 200,
			contentType: asset.contentType,
			headers,
			body: asset.body,
		});
		return;
	}
	const start = Number(range[1]);
	const end = range[2]
		? Math.min(Number(range[2]), asset.body.length - 1)
		: asset.body.length - 1;
	if (start >= asset.body.length || end < start) {
		await route.fulfill({
			status: 416,
			contentType: asset.contentType,
			headers: { ...headers, "Content-Range": `bytes */${asset.body.length}` },
		});
		return;
	}
	await route.fulfill({
		status: 206,
		contentType: asset.contentType,
		headers: {
			...headers,
			"Content-Range": `bytes ${start}-${end}/${asset.body.length}`,
		},
		body: asset.body.subarray(start, end + 1),
	});
}

async function replay(forceWebGl, forceWebGpu = false) {
	const background = await sharp(
		Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="120" height="240" fill="#cc1242"/><rect x="120" width="120" height="240" fill="#1235cc"/></svg>',
		),
	)
		.png()
		.toBuffer();
	const rawBackground = fs.readFileSync(
		path.join(__dirname, "raw-background.png"),
	);
	const exifBackground = fs.readFileSync(
		path.join(__dirname, "exif-background-6.jpg"),
	);
	const largeBackground = fs.readFileSync(
		path.join(__dirname, "large-background.png"),
	);
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
			deviceScaleFactor: Number(process.env.CAP_REPLAY_DPR || 1),
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
		await page.addInitScript((simulateFailedProbe) => {
			const getContext = HTMLCanvasElement.prototype.getContext;
			HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
				const result = getContext.call(this, kind, ...args);
				if (
					simulateFailedProbe &&
					kind === "webgpu" &&
					result &&
					this.width === 8 &&
					this.height === 8
				) {
					this.CapReplayProbeCanvas = true;
				}
				if (kind === "webgl2" || kind === "webgpu") {
					console.info(
						`Cap replay stage: canvas ${kind} context ${result ? "ready" : "unavailable"}${kind === "webgl2" && result ? ` lost=${result.isContextLost()}` : ""}`,
					);
				}
				return result;
			};
			if (simulateFailedProbe) {
				const toBlob = HTMLCanvasElement.prototype.toBlob;
				HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
					if (this.CapReplayProbeCanvas) {
						window.CapReplayProbeForcedFailure = true;
						queueMicrotask(() => callback(null));
						return;
					}
					return toBlob.call(this, callback, ...args);
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
				if (adapter?.info) {
					window.CapReplayGpuAdapterArchitecture = adapter.info.architecture;
					console.info(
						`Cap replay stage: WebGPU adapter info ${JSON.stringify({ vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description })}`,
					);
				}
				return simulateFailedProbe && adapter
					? {
							info: { ...adapter.info, architecture: "probe-test" },
							requestDevice: (...deviceArgs) =>
								adapter.requestDevice(...deviceArgs),
						}
					: adapter;
			};
		}, simulateFailedProbe);
		page.on("request", (request) => {
			if (request.url().includes("/api/editor/sessions/")) {
				workerRequests.push(request.url());
			}
		});
		await page.exposeFunction("CapReplayPresentedIndex", async () => {
			const screenshot = await page.locator("canvas").first().screenshot();
			const { data, info } = await sharp(screenshot)
				.raw()
				.toBuffer({ resolveWithObject: true });
			let index = 0;
			for (let bit = 0; bit < 8; bit++) {
				const x = Math.floor(((bit + 0.5) * info.width) / 8);
				const y = Math.floor(info.height / 4);
				const offset = (y * info.width + x) * info.channels;
				if (data[offset] + data[offset + 1] + data[offset + 2] > 384) {
					index |= 1 << bit;
				}
			}
			return index;
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
								url: `${origin}/screen.${screen.format}`,
								contentType: screen.contentType,
								fps: 30,
							},
							camera: {
								url: `${origin}/camera.${camera.format}`,
								contentType: camera.contentType,
								fps: 30,
								offsetMs: 0,
							},
						},
					}),
				});
				return;
			}
			if (pathname === `/screen.${screen.format}`) {
				await fulfillMedia(route, screen);
				return;
			}
			if (pathname === `/camera.${camera.format}`) {
				await fulfillMedia(route, camera);
				return;
			}
			if (pathname === "/browser-replay/large-background.png") {
				await route.fulfill({
					status: 200,
					contentType: "image/png",
					body: largeBackground,
				});
				return;
			}
			if (pathname === "/api/editor/videos/fixture/file") {
				const requested = new URL(route.request().url()).searchParams.get(
					"path",
				);
				const exif = requested?.endsWith("000000000002.jpg") ?? false;
				await route.fulfill({
					status: 200,
					contentType: exif ? "image/jpeg" : "image/png",
					body: exif
						? exifBackground
						: requested?.endsWith("000000000002.png")
							? rawBackground
							: background,
				});
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
		const largeImage = await page.evaluate(async () => {
			const decoder = new window.CapBrowserImageDecoder();
			try {
				const response = await fetch("/browser-replay/large-background.png");
				if (!response.ok) throw new Error("Large image fixture is unavailable");
				const started = performance.now();
				const image = await decoder.decode(await response.arrayBuffer());
				const decodeMs = performance.now() - started;
				const pixels = new Uint8ClampedArray(image.pixels);
				const bitmapStarted = performance.now();
				const bitmap = await createImageBitmap(
					new ImageData(pixels, image.width, image.height),
					{ premultiplyAlpha: "none", colorSpaceConversion: "none" },
				);
				const bitmapMs = performance.now() - bitmapStarted;
				const canvas = document.createElement("canvas");
				canvas.width = bitmap.width;
				canvas.height = bitmap.height;
				const context = canvas.getContext("2d", { willReadFrequently: true });
				if (!context) throw new Error("Large image canvas is unavailable");
				context.drawImage(bitmap, 0, 0);
				const observed = context.getImageData(
					0,
					0,
					image.width,
					image.height,
				).data;
				const digest = async (bytes) =>
					Array.from(
						new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
					)
						.map((value) => value.toString(16).padStart(2, "0"))
						.join("");
				const rawSha256 = await digest(pixels);
				const bitmapSha256 = await digest(observed);
				bitmap.close();
				return {
					width: image.width,
					height: image.height,
					decodeMs,
					bitmapMs,
					rawSha256,
					bitmapSha256,
				};
			} finally {
				decoder.dispose();
			}
		});
		const nativeImageSha256 =
			"ffe919d64110a31ef1862854bf685b3d0d70f2e0a96b9f9203f3026f2334224e";
		assert(
			largeImage.width === 2560 && largeImage.height === 1707,
			"Large image dimensions differ from native export",
		);
		assert(
			largeImage.rawSha256 === nativeImageSha256,
			"Large image downscaling differs from native export",
		);
		assert(
			largeImage.bitmapSha256 === nativeImageSha256,
			"Large image browser bitmap differs from native export",
		);
		await page.evaluate(
			({ indexed, headed }) => {
				window.CapReplayIndexed = indexed;
				window.CapReplayHeaded = headed;
			},
			{ indexed, headed: process.env.CAP_REPLAY_HEADED === "1" },
		);
		let replayTimer;
		const result = await Promise.race([
			page.evaluate(async (mediaFormat) => {
				const indexed = window.CapReplayIndexed;
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
						video.src = `/screen.${mediaFormat}`;
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
					if (/webgpu/i.test(backend)) {
						playback.canvas.renderer.redraw_last();
						const captured = await new Promise((resolve) =>
							canvas.toBlob(resolve, "image/png"),
						);
						if (captured) {
							const bitmap = await createImageBitmap(captured);
							const sample = document.createElement("canvas");
							sample.width = bitmap.width;
							sample.height = bitmap.height;
							const sampleContext = sample.getContext("2d", {
								willReadFrequently: true,
							});
							if (sampleContext) {
								sampleContext.drawImage(bitmap, 0, 0);
								const pixels = sampleContext.getImageData(
									0,
									0,
									bitmap.width,
									bitmap.height,
								).data;
								let nonblack = 0;
								for (let index = 0; index < pixels.length; index += 4) {
									if (
										pixels[index] + pixels[index + 1] + pixels[index + 2] >
										48
									) {
										nonblack++;
									}
								}
								console.info(
									`Cap replay stage: WebGPU canvas toBlob nonblack ${nonblack}/${bitmap.width * bitmap.height}`,
								);
							}
							bitmap.close();
						}
					}
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
					const originalPadding = config.background.padding;
					config.background.padding = 50;
					await playback.setConfig(config);
					const paddedSolid = await snapshot();
					const importedImagePath =
						"/api/editor/videos/fixture/file?raw=1&path=content/images/00000000-0000-0000-0000-000000000001.png";
					config.background.source = {
						type: "image",
						path: importedImagePath,
					};
					await playback.setConfig(config);
					const imageChangedPixels = differentPixels(
						paddedSolid,
						await snapshot(),
					);
					config.background.source = {
						type: "image",
						path: "/api/editor/videos/fixture/file?raw=1&path=content/images/00000000-0000-0000-0000-000000000002.png",
					};
					await playback.setConfig(config);
					const rawJpegPixels = await snapshot();
					config.background.source = {
						type: "image",
						path: "/api/editor/videos/fixture/file?raw=1&path=content/images/00000000-0000-0000-0000-000000000002.jpg",
					};
					await playback.setConfig(config);
					const exifOrientationChangedPixels = differentPixels(
						rawJpegPixels,
						await snapshot(),
					);
					if (exifOrientationChangedPixels > 1000) {
						throw new Error("JPEG EXIF orientation differs from native export");
					}
					config.background.padding = originalPadding;
					config.background.source = JSON.parse(
						playback.module.default_project_config_json(),
					).background.source;
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
					config.background.source = {
						type: "animatedGradient",
						config: JSON.parse(
							playback.module.random_animated_gradient_json(1234),
						),
					};
					await playback.setConfig(config);
					await playback.seek(0);
					const gradientStart = await snapshot();
					const gradientChangedPixels = differentPixels(
						withCamera,
						gradientStart,
					);
					await playback.seek(0.75);
					const gradientMotionPixels = differentPixels(
						gradientStart,
						await snapshot(),
					);
					const sourceDuration = Math.min(playback.sourceDurations[0], 2);
					const split = sourceDuration * 0.6;
					const transitionDuration = 0.3;
					config.timeline = {
						segments: [
							{
								recordingSegment: 0,
								start: 0,
								end: split,
								timescale: 1,
							},
							{
								recordingSegment: 0,
								start: split,
								end: sourceDuration,
								timescale: 1,
							},
						],
						transitions: [
							{
								segmentIndex: 1,
								type: "cross-fade",
								duration: transitionDuration,
							},
						],
						zoomSegments: [],
					};
					await playback.setConfig(config);
					const transitionStart = split - transitionDuration;
					await playback.seek(transitionStart + transitionDuration * 0.2);
					const transitionFirst = await snapshot();
					await playback.seek(transitionStart + transitionDuration * 0.5);
					const transitionMiddle = await snapshot();
					await playback.seek(transitionStart + transitionDuration * 0.8);
					const transitionLast = await snapshot();
					const transitionChangedPixels =
						differentPixels(transitionFirst, transitionMiddle) +
						differentPixels(transitionMiddle, transitionLast);
					if (
						playback.timeline.map_frame(
							transitionStart + transitionDuration * 0.5,
						)[0] !== 2 ||
						transitionChangedPixels === 0
					) {
						throw new Error(
							"Paired animated-gradient transition did not render",
						);
					}
					config.background.source = {
						type: "image",
						path: importedImagePath,
					};
					await playback.setConfig(config);
					await playback.seek(transitionStart + transitionDuration * 0.5);
					const imageTransitionChangedPixels = differentPixels(
						transitionMiddle,
						await snapshot(),
					);
					if (imageTransitionChangedPixels < 1000) {
						throw new Error(
							"Paired image-background transition did not render",
						);
					}
					config.timeline = undefined;
					config.background.source = JSON.parse(
						playback.module.default_project_config_json(),
					).background.source;
					await playback.setConfig(config);
					await playback.seek(0.75);
					const beforePlay = frames.length;
					playback.play();
					const playbackIntervalMs =
						window.CapReplayGpuAdapterArchitecture === "swiftshader"
							? 2500
							: 850;
					await new Promise((resolve) =>
						setTimeout(resolve, playbackIntervalMs),
					);
					console.info("Cap replay stage: playback interval completed");
					playback.pause();
					const playedFrames = frames.length - beforePlay;
					let indexedParity = null;
					if (indexed) {
						config.background.padding = 0;
						config.timeline = {
							segments: [
								{
									recordingSegment: 0,
									start: 0,
									end: playback.sourceDurations[0],
									timescale: 8,
								},
							],
							transitions: [],
							zoomSegments: [],
						};
						await playback.setConfig(config);
						await playback.seek(0);
						const sourceCanvas = document.createElement("canvas");
						sourceCanvas.width = 8;
						sourceCanvas.height = 1;
						const sourceContext = sourceCanvas.getContext("2d", {
							willReadFrequently: true,
						});
						const retainedCanvas = document.createElement("canvas");
						const retainedContext = retainedCanvas.getContext("2d", {
							willReadFrequently: true,
						});
						if (!sourceContext || !retainedContext) {
							throw new Error("Indexed frame inspection is unavailable");
						}
						const readIndex = (pixelAt, width, height, inverted) => {
							let index = 0;
							for (let bit = 0; bit < 8; bit++) {
								const pixel = pixelAt(
									Math.floor(((bit + 0.5) * width) / 8),
									Math.floor(height / 4),
								);
								const white = pixel[0] + pixel[1] + pixel[2] > 384;
								if (white !== inverted) index |= 1 << bit;
							}
							return index;
						};
						const mismatches = [];
						const samples = { display: 0, camera: 0, gpu: 0 };
						const originalFrame = playback.pool.frame.bind(playback.pool);
						playback.pool.frame = async (...args) => {
							const video = await originalFrame(...args);
							if (video) {
								sourceContext.drawImage(video, 0, 0, 8, 1);
								const observed = readIndex(
									(x, y) => sourceContext.getImageData(x, y, 1, 1).data,
									8,
									1,
									args[1] === "camera",
								);
								const target = Math.round(args[3] * 30);
								samples[args[1]]++;
								if (Math.abs(observed - target) > 1) {
									mismatches.push(`${args[1]} ${target}/${observed}`);
								}
							}
							return video;
						};
						const originalRender = playback.canvas.render.bind(playback.canvas);
						const gpuReads = [];
						let inspectGpu = true;
						playback.canvas.render = (...args) => {
							if (!inspectGpu) return originalRender(...args);
							const read = (async () => {
								await originalRender(...args);
								let observed;
								if (/webgpu/i.test(backend) && !window.CapReplayHeaded) {
									const pixels = await playback.canvas.renderer.snapshot_rgba();
									observed = readIndex(
										(x, y) =>
											pixels.subarray(
												(y * canvas.width + x) * 4,
												(y * canvas.width + x) * 4 + 4,
											),
										canvas.width,
										canvas.height,
										false,
									);
								} else if (/webgpu/i.test(backend)) {
									await new Promise(requestAnimationFrame);
									await new Promise(requestAnimationFrame);
									observed = await window.CapReplayPresentedIndex();
								} else {
									if (!playback.drawLatestFrameToCanvas(retainedCanvas)) {
										throw new Error("Indexed GPU frame is unavailable");
									}
									observed = readIndex(
										(x, y) => retainedContext.getImageData(x, y, 1, 1).data,
										retainedCanvas.width,
										retainedCanvas.height,
										false,
									);
								}
								const target = Math.round((Number(args[2]) / 1e9) * 8 * 30);
								samples.gpu++;
								if (Math.abs(observed - target) > 1) {
									mismatches.push(`gpu ${target}/${observed}`);
								}
							})();
							gpuReads.push(read);
							return read;
						};
						const probeTimes = [0.05, 0.15, 0.25, 0.35, 0.45];
						for (const time of probeTimes) await playback.seek(time);
						await playback.seek(0);
						inspectGpu = false;
						const beforeLiveSamples = { ...samples };
						const beforeIndexedPlay = frames.length;
						playback.play();
						await new Promise((resolve) => setTimeout(resolve, 2000));
						playback.pause();
						await Promise.all(gpuReads);
						indexedParity = {
							playedFrames: frames.length - beforeIndexedPlay,
							pausedProbes: probeTimes.length,
							samples,
							liveSamples: {
								display: samples.display - beforeLiveSamples.display,
								camera: samples.camera - beforeLiveSamples.camera,
							},
							mismatches,
						};
						console.info(
							`Cap replay stage: indexed parity ${JSON.stringify(indexedParity)}`,
						);
					}
					const videos = Array.from(document.querySelectorAll("video")).map(
						(video) => [video.videoWidth, video.videoHeight],
					);
					return {
						backend,
						gpuAdapterArchitecture:
							window.CapReplayGpuAdapterArchitecture ?? null,
						probeForcedFailure: window.CapReplayProbeForcedFailure === true,
						firstFrameMs,
						seekMs,
						returnToStartMs,
						changedPixels,
						imageChangedPixels,
						exifOrientationChangedPixels,
						startChangedPixels,
						gradientChangedPixels,
						gradientMotionPixels,
						transitionChangedPixels,
						playedFrames,
						indexedParity,
						videos,
						width: canvas.width,
						height: canvas.height,
						errors,
					};
				} catch (error) {
					console.info(
						`Cap replay stage: stalled video state ${JSON.stringify(Array.from(document.querySelectorAll("video")).map((video) => ({ path: video.currentSrc ? new URL(video.currentSrc).pathname : "", currentTime: video.currentTime, duration: video.duration, readyState: video.readyState, networkState: video.networkState, seeking: video.seeking, paused: video.paused, width: video.videoWidth, height: video.videoHeight, error: video.error?.code ?? null })))}`,
					);
					throw error;
				} finally {
					playback.dispose();
				}
			}, screen.format),
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
			result.imageChangedPixels > 1000,
			"Imported image background did not change the GPU frame",
		);
		assert(
			result.startChangedPixels < 100,
			"Returning to the start did not reproduce the first GPU frame",
		);
		assert(
			result.gradientChangedPixels > 1000,
			"Animated gradient did not change the GPU frame",
		);
		assert(
			result.gradientMotionPixels > 1000,
			"Animated gradient did not move across the timeline",
		);
		assert(
			result.transitionChangedPixels > 1000,
			"Paired animated-gradient transition did not change the GPU frame",
		);
		assert(result.playedFrames >= 2, "Local playback did not advance");
		if (indexed) {
			assert(result.indexedParity !== null, "Indexed parity did not run");
			assert(
				result.indexedParity.playedFrames >= 2,
				"8× local playback did not keep advancing",
			);
			assert(
				result.indexedParity.pausedProbes === 5,
				"8× paused timestamps were not inspected",
			);
			assert(
				result.indexedParity.samples.display >= 5,
				"8× display frames were not inspected",
			);
			assert(
				result.indexedParity.samples.camera >= 5,
				"8× camera frames were not inspected",
			);
			assert(
				result.indexedParity.samples.gpu >= 5,
				"8× GPU frames were not inspected",
			);
			assert(
				result.indexedParity.liveSamples.display >= 2 &&
					result.indexedParity.liveSamples.camera >= 2,
				"8× paired playback stopped requesting decoded frames",
			);
			assert(
				result.indexedParity.mismatches.length === 0,
				`8× playback/export frame mismatch: ${result.indexedParity.mismatches.join(", ")}`,
			);
		}
		assert(
			result.videos.some(
				([width, height]) =>
					width === expectedScreenWidth && height === expectedScreenHeight,
			),
			"Screen clip did not decode",
		);
		assert(
			result.videos.some(
				([width, height]) =>
					width === expectedCameraWidth && height === expectedCameraHeight,
			),
			"Camera clip did not decode",
		);
		if (forceWebGl)
			assert(/gl/i.test(result.backend), "WebGL fallback was not selected");
		if (simulateFailedProbe) {
			assert(
				result.probeForcedFailure,
				"Failed WebGPU probe was not exercised",
			);
			assert(
				/gl/i.test(result.backend),
				"Failed WebGPU probe did not select WebGL2",
			);
		} else if (forceWebGpu) {
			if (process.env.CAP_REPLAY_ALLOW_AUTO_FALLBACK === "1") {
				assert(
					result.gpuAdapterArchitecture !== null,
					"WebGPU adapter identity was unavailable",
				);
				assert(
					result.gpuAdapterArchitecture === "swiftshader"
						? /gl/i.test(result.backend)
						: /webgpu/i.test(result.backend),
					"Browser selected the wrong compositor for its GPU adapter",
				);
			} else {
				assert(/webgpu/i.test(result.backend), "WebGPU path was not selected");
			}
		}
		console.log(
			JSON.stringify({
				browser: browserName,
				forceWebGl,
				forceWebGpu,
				largeImage,
				...result,
			}),
		);
	} finally {
		await browser.close();
	}
}

async function main() {
	const modes = simulateFailedProbe
		? [[false, true]]
		: process.env.CAP_REPLAY_ONLY_WEBGL === "1"
			? [[true, false]]
			: process.env.CAP_REPLAY_REQUIRE_WEBGPU === "1"
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
