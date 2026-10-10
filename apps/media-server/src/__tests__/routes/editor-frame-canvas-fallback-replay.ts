import assert from "node:assert/strict";
import { resolve } from "node:path";
import { type Browser, chromium, webkit } from "@playwright/test";

type PreviewResult = {
	rgba: number[];
	width: number;
	height: number;
	frameNumber: number;
	closed: boolean;
	decodeMs: number;
	sha256?: string;
	longTasks?: number;
};

const entrypoint = resolve(
	import.meta.dir,
	"../../../../../packages/editor-solid-web/src/websocket.ts",
);
const bundle = await Bun.build({
	entrypoints: [entrypoint],
	target: "browser",
	format: "esm",
});
assert.ok(bundle.success, bundle.logs.map((log) => log.message).join("\n"));
assert.equal(bundle.outputs.length, 1);
const source = await bundle.outputs[0]?.text();
assert.ok(source);

async function createReplayPage(browser: Browser) {
	const page = await browser.newPage();
	const url = "https://editor.cap.so/canvas-fallback-replay";
	await page.route(url, (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><html><body></body></html>",
		}),
	);
	await page.goto(url);
	return page;
}

async function replayPng(
	browser: Browser,
	options: {
		noOffscreenCanvas: boolean;
		noImageBitmap: boolean;
		offscreenContextUnavailable?: boolean;
		width?: number;
		height?: number;
		frames?: number;
	},
): Promise<PreviewResult> {
	const page = await createReplayPage(browser);
	try {
		return await page.evaluate(
			async ({ source, options }) => {
				if (options.noOffscreenCanvas) {
					Object.defineProperty(globalThis, "OffscreenCanvas", {
						value: undefined,
						configurable: true,
					});
				}
				if (options.noImageBitmap) {
					Object.defineProperty(globalThis, "createImageBitmap", {
						value: undefined,
						configurable: true,
					});
				}
				if (options.offscreenContextUnavailable) {
					class No2DOffscreenCanvas {
						constructor(
							readonly width: number,
							readonly height: number,
						) {}
						getContext() {
							return null;
						}
					}
					Object.defineProperty(globalThis, "OffscreenCanvas", {
						value: No2DOffscreenCanvas,
						configurable: true,
					});
				}
				const moduleUrl = URL.createObjectURL(
					new Blob([source], { type: "text/javascript" }),
				);
				const editor = (await import(
					moduleUrl
				)) as typeof import("../../../../../packages/editor-solid-web/src/websocket");
				URL.revokeObjectURL(moduleUrl);
				class MockWebSocket extends EventTarget {
					static readonly OPEN = 1;
					readonly readyState = 1;
					binaryType: BinaryType = "blob";
					closed = false;
					send() {}
					close() {
						this.closed = true;
					}
				}
				globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
				const width = options.width ?? 2;
				const height = options.height ?? 2;
				const frameCanvas = document.createElement("canvas");
				frameCanvas.width = width;
				frameCanvas.height = height;
				const frameContext = frameCanvas.getContext("2d");
				if (!frameContext) throw new Error("Fixture canvas is unavailable");
				if (width === 2 && height === 2) {
					const pixels = new Uint8ClampedArray([
						255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
					]);
					frameContext.putImageData(new ImageData(pixels, 2, 2), 0, 0);
				} else {
					const gradient = frameContext.createLinearGradient(
						0,
						0,
						width,
						height,
					);
					gradient.addColorStop(0, "#132a4a");
					gradient.addColorStop(1, "#ddc89a");
					frameContext.fillStyle = gradient;
					frameContext.fillRect(0, 0, width, height);
					frameContext.font = "32px sans-serif";
					for (let line = 0; line < 24; line++) {
						frameContext.fillStyle = line % 2 === 0 ? "#ffffff" : "#141414";
						frameContext.fillText(
							`Cap editor preview frame ${line}: transcript, timeline, and camera controls`,
							36,
							48 + line * 40,
						);
					}
				}
				const pngBlob = await new Promise<Blob>((resolve, reject) => {
					frameCanvas.toBlob((blob) => {
						if (blob) resolve(blob);
						else reject(new Error("Fixture PNG could not encode"));
					}, "image/png");
				});
				const png = new Uint8Array(await pngBlob.arrayBuffer());
				const packet = new ArrayBuffer(8 + png.length + 24);
				const bytes = new Uint8Array(packet);
				bytes.set([67, 65, 80, 80, 78, 71, 48, 49]);
				bytes.set(png, 8);
				const footer = new DataView(packet, packet.byteLength - 24, 24);
				footer.setUint32(4, height, true);
				footer.setUint32(8, width, true);
				footer.setUint32(12, 7, true);
				footer.setBigUint64(16, 1_234_567n, true);
				const url =
					"wss://editor.cap.so/editor/sessions/canvas-fallback/frames";
				editor.setEditorFrameSocketCredential({ url, ticket: "a".repeat(43) });
				const socket = editor.createWS(url) as unknown as MockWebSocket;
				let longTasks = 0;
				let observer: PerformanceObserver | null = null;
				try {
					observer = new PerformanceObserver((list) => {
						longTasks += list.getEntries().length;
					});
					observer.observe({ entryTypes: ["longtask"] });
				} catch {
					observer = null;
				}
				const decodeTimes: number[] = [];
				let raw = new ArrayBuffer(0);
				for (let frame = 0; frame < (options.frames ?? 1); frame++) {
					const startedAt = performance.now();
					raw = await new Promise<ArrayBuffer>((resolve, reject) => {
						const timeout = window.setTimeout(
							() => reject(new Error("Editor PNG frame was not delivered")),
							5000,
						);
						socket.addEventListener(
							"message",
							(event) => {
								if (!(event instanceof MessageEvent)) return;
								if (
									!(event.data instanceof ArrayBuffer) ||
									event.data.byteLength !== width * height * 4 + 24
								)
									return;
								window.clearTimeout(timeout);
								resolve(event.data);
							},
							{ once: true },
						);
						socket.dispatchEvent(new MessageEvent("message", { data: packet }));
					});
					decodeTimes.push(performance.now() - startedAt);
				}
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				observer?.disconnect();
				const decodeMs =
					[...decodeTimes].sort((a, b) => a - b)[
						Math.floor(decodeTimes.length / 2)
					] ?? 0;
				const rawFooter = new DataView(raw, width * height * 4, 24);
				const digest = await crypto.subtle.digest(
					"SHA-256",
					new Uint8Array(raw, 0, width * height * 4),
				);
				const sha256 = Array.from(new Uint8Array(digest), (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
				return {
					rgba: Array.from(new Uint8Array(raw, 0, 16)),
					width: rawFooter.getUint32(8, true),
					height: rawFooter.getUint32(4, true),
					frameNumber: rawFooter.getUint32(12, true),
					closed: socket.closed,
					decodeMs,
					sha256,
					longTasks,
				};
			},
			{ source, options },
		);
	} finally {
		await page.close();
	}
}

async function replayH264Canvas(browser: Browser): Promise<PreviewResult> {
	const page = await createReplayPage(browser);
	try {
		return await page.evaluate(async (source) => {
			if (
				typeof VideoFrame === "undefined" ||
				typeof EncodedVideoChunk === "undefined"
			) {
				throw new Error("Chromium VideoFrame is unavailable");
			}
			Object.defineProperty(globalThis, "OffscreenCanvas", {
				value: undefined,
				configurable: true,
			});
			const moduleUrl = URL.createObjectURL(
				new Blob([source], { type: "text/javascript" }),
			);
			const editor = (await import(
				moduleUrl
			)) as typeof import("../../../../../packages/editor-solid-web/src/websocket");
			URL.revokeObjectURL(moduleUrl);
			const frameCanvas = document.createElement("canvas");
			frameCanvas.width = 2;
			frameCanvas.height = 2;
			const frameContext = frameCanvas.getContext("2d");
			if (!frameContext) throw new Error("H.264 fixture canvas is unavailable");
			frameContext.putImageData(
				new ImageData(
					new Uint8ClampedArray([
						255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
					]),
					2,
					2,
				),
				0,
				0,
			);
			class MockVideoDecoder {
				static async isConfigSupported() {
					return { supported: true };
				}
				readonly decodeQueueSize = 0;
				constructor(private readonly callbacks: VideoDecoderInit) {}
				configure() {}
				decode(chunk: EncodedVideoChunk) {
					const frame = new VideoFrame(frameCanvas, {
						timestamp: chunk.timestamp,
					});
					Object.defineProperty(frame, "allocationSize", {
						value: () => {
							throw new Error("Use canvas frame conversion");
						},
					});
					this.callbacks.output(frame);
				}
				close() {}
			}
			globalThis.VideoDecoder =
				MockVideoDecoder as unknown as typeof VideoDecoder;
			class MockWebSocket extends EventTarget {
				static readonly OPEN = 1;
				readonly readyState = 1;
				binaryType: BinaryType = "blob";
				closed = false;
				send() {}
				close() {
					this.closed = true;
				}
			}
			globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
			const url = "wss://editor.cap.so/editor/sessions/h264-canvas/frames";
			editor.setEditorFrameSocketCredential({ url, ticket: "b".repeat(43) });
			const socket = editor.createWS(url) as unknown as MockWebSocket;
			socket.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						kind: "cap-h264-config",
						codec: "avc1.42e01e",
						width: 2,
						height: 2,
					}),
				}),
			);
			await new Promise((resolve) => window.setTimeout(resolve, 20));
			const packet = new ArrayBuffer(42);
			const bytes = new Uint8Array(packet);
			bytes.set([67, 65, 80, 72, 50, 54, 52, 49]);
			const header = new DataView(packet, 0, 41);
			header.setBigUint64(8, 1n, true);
			header.setUint8(16, 1);
			header.setUint32(17, 2, true);
			header.setUint32(21, 2, true);
			header.setUint32(25, 7, true);
			header.setBigUint64(29, 1_234_567n, true);
			header.setUint32(37, 1, true);
			bytes[41] = 1;
			const startedAt = performance.now();
			const raw = await new Promise<ArrayBuffer>((resolve, reject) => {
				const timeout = window.setTimeout(
					() =>
						reject(new Error("Editor H.264 canvas frame was not delivered")),
					5000,
				);
				socket.addEventListener("message", (event) => {
					if (!(event instanceof MessageEvent)) return;
					if (
						!(event.data instanceof ArrayBuffer) ||
						event.data.byteLength !== 40
					)
						return;
					window.clearTimeout(timeout);
					resolve(event.data);
				});
				socket.dispatchEvent(new MessageEvent("message", { data: packet }));
			});
			const decodeMs = performance.now() - startedAt;
			const footer = new DataView(raw, 16, 24);
			return {
				rgba: Array.from(new Uint8Array(raw, 0, 16)),
				width: footer.getUint32(8, true),
				height: footer.getUint32(4, true),
				frameNumber: footer.getUint32(12, true),
				closed: socket.closed,
				decodeMs,
			};
		}, source);
	} finally {
		await page.close();
	}
}

for (const [name, engine] of [
	["Chromium", chromium],
	["WebKit", webkit],
] as const) {
	const browser = await engine.launch({ headless: true });
	try {
		const baseline = await replayPng(browser, {
			noOffscreenCanvas: false,
			noImageBitmap: false,
		});
		const canvasFallback = await replayPng(browser, {
			noOffscreenCanvas: true,
			noImageBitmap: false,
		});
		const imageFallback = await replayPng(browser, {
			noOffscreenCanvas: true,
			noImageBitmap: true,
		});
		const bitmapOnlyFallback = await replayPng(browser, {
			noOffscreenCanvas: false,
			noImageBitmap: true,
		});
		const noOffscreen2D = await replayPng(browser, {
			noOffscreenCanvas: false,
			noImageBitmap: false,
			offscreenContextUnavailable: true,
		});
		for (const result of [
			baseline,
			canvasFallback,
			imageFallback,
			bitmapOnlyFallback,
			noOffscreen2D,
		]) {
			assert.deepEqual(
				result.rgba,
				[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255],
			);
			assert.equal(result.width, 2);
			assert.equal(result.height, 2);
			assert.equal(result.frameNumber, 7);
			assert.equal(result.closed, false);
		}
		assert.deepEqual(canvasFallback.rgba, baseline.rgba);
		assert.deepEqual(imageFallback.rgba, baseline.rgba);
		assert.deepEqual(bitmapOnlyFallback.rgba, baseline.rgba);
		assert.deepEqual(noOffscreen2D.rgba, baseline.rgba);
		const output: Record<string, unknown> = {
			browser: name,
			pngBaselineMs: baseline.decodeMs,
			pngCanvasFallbackMs: canvasFallback.decodeMs,
			pngImageFallbackMs: imageFallback.decodeMs,
			pngBitmapOnlyFallbackMs: bitmapOnlyFallback.decodeMs,
			pngNoOffscreen2DMs: noOffscreen2D.decodeMs,
		};
		const largeOptions = { width: 1920, height: 1080, frames: 10 };
		const largeBaseline = await replayPng(browser, {
			...largeOptions,
			noOffscreenCanvas: false,
			noImageBitmap: false,
		});
		const largeCanvasFallback = await replayPng(browser, {
			...largeOptions,
			noOffscreenCanvas: true,
			noImageBitmap: false,
		});
		const largeImageFallback = await replayPng(browser, {
			...largeOptions,
			noOffscreenCanvas: true,
			noImageBitmap: true,
		});
		for (const result of [
			largeBaseline,
			largeCanvasFallback,
			largeImageFallback,
		]) {
			assert.equal(result.width, 1920);
			assert.equal(result.height, 1080);
			assert.equal(result.frameNumber, 7);
			assert.equal(result.closed, false);
			assert.ok(result.sha256);
		}
		assert.equal(largeCanvasFallback.sha256, largeBaseline.sha256);
		assert.equal(largeImageFallback.sha256, largeBaseline.sha256);
		output.large1080p = {
			baselineMedianMs: largeBaseline.decodeMs,
			canvasFallbackMedianMs: largeCanvasFallback.decodeMs,
			imageFallbackMedianMs: largeImageFallback.decodeMs,
			baselineLongTasks: largeBaseline.longTasks,
			canvasFallbackLongTasks: largeCanvasFallback.longTasks,
			imageFallbackLongTasks: largeImageFallback.longTasks,
			sha256: largeBaseline.sha256,
		};
		if (name === "Chromium") {
			const h264Fallback = await replayH264Canvas(browser);
			assert.deepEqual(h264Fallback.rgba, baseline.rgba);
			assert.equal(h264Fallback.closed, false);
			output.h264CanvasFallbackMs = h264Fallback.decodeMs;
		}
		console.log(JSON.stringify(output));
	} finally {
		await browser.close();
	}
}
