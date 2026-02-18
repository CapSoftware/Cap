import { createWS } from "@solid-primitives/websocket";
import { createResource, createSignal } from "solid-js";
import FrameWorker from "./frame-worker?worker";
import {
	createProducer,
	createSharedFrameBuffer,
	isSharedArrayBufferSupported,
	type Producer,
	type SharedFrameBufferConfig,
} from "./shared-frame-buffer";
import type { StrideCorrectionResponse } from "./stride-correction-worker";
import StrideCorrectionWorker from "./stride-correction-worker?worker";
import {
	disposeWebGPU,
	initWebGPU,
	isWebGPUSupported,
	renderFrameWebGPU,
	renderNv12FrameWebGPU,
	type WebGPURenderer,
} from "./webgpu-renderer";

const SAB_SUPPORTED = isSharedArrayBufferSupported();
const FRAME_BUFFER_CONFIG: SharedFrameBufferConfig = {
	slotCount: 6,
	slotSize: 16 * 1024 * 1024,
};

let mainThreadNv12Buffer: Uint8ClampedArray | null = null;
let mainThreadNv12BufferSize = 0;

export type FpsStats = {
	fps: number;
	renderFps: number;
	avgFrameMs: number;
	minFrameMs: number;
	maxFrameMs: number;
	mbPerSec: number;
};

let globalFpsStatsGetter: (() => FpsStats) | null = null;

export function getFpsStats(): FpsStats | null {
	if (globalFpsStatsGetter) {
		return globalFpsStatsGetter();
	}
	return null;
}

function convertNv12ToRgbaMainThread(
	nv12Data: Uint8ClampedArray,
	width: number,
	height: number,
	yStride: number,
): Uint8ClampedArray {
	const rgbaSize = width * height * 4;
	if (!mainThreadNv12Buffer || mainThreadNv12BufferSize < rgbaSize) {
		mainThreadNv12Buffer = new Uint8ClampedArray(rgbaSize);
		mainThreadNv12BufferSize = rgbaSize;
	}
	const rgba = mainThreadNv12Buffer;

	const ySize = yStride * height;
	const yPlane = nv12Data;
	const uvPlane = nv12Data.subarray(ySize);
	const uvStride = yStride;

	for (let row = 0; row < height; row++) {
		const yRowOffset = row * yStride;
		const uvRowOffset = Math.floor(row / 2) * uvStride;
		const rgbaRowOffset = row * width * 4;

		for (let col = 0; col < width; col++) {
			const y = yPlane[yRowOffset + col] - 16;

			const uvCol = Math.floor(col / 2) * 2;
			const u = uvPlane[uvRowOffset + uvCol] - 128;
			const v = uvPlane[uvRowOffset + uvCol + 1] - 128;

			const c = 298 * y;
			const d = u;
			const e = v;

			let r = (c + 409 * e + 128) >> 8;
			let g = (c - 100 * d - 208 * e + 128) >> 8;
			let b = (c + 516 * d + 128) >> 8;

			r = r < 0 ? 0 : r > 255 ? 255 : r;
			g = g < 0 ? 0 : g > 255 ? 255 : g;
			b = b < 0 ? 0 : b > 255 ? 255 : b;

			const rgbaOffset = rgbaRowOffset + col * 4;
			rgba[rgbaOffset] = r;
			rgba[rgbaOffset + 1] = g;
			rgba[rgbaOffset + 2] = b;
			rgba[rgbaOffset + 3] = 255;
		}
	}

	return rgba.subarray(0, rgbaSize);
}

export type FrameData = {
	width: number;
	height: number;
	bitmap?: ImageBitmap | null;
};

export type CanvasControls = {
	initCanvas: (canvas: OffscreenCanvas) => void;
	resizeCanvas: (width: number, height: number) => void;
	hasRenderedFrame: () => boolean;
	initDirectCanvas: (canvas: HTMLCanvasElement) => void;
	resetFrameState: () => void;
	captureFrame: () => Promise<Blob | null>;
};

interface ReadyMessage {
	type: "ready";
}

interface FrameRenderedMessage {
	type: "frame-rendered";
	width: number;
	height: number;
}

interface FrameQueuedMessage {
	type: "frame-queued";
	width: number;
	height: number;
}

interface DecodedFrame {
	type: "decoded";
	bitmap: ImageBitmap;
	width: number;
	height: number;
}

interface ErrorMessage {
	type: "error";
	message: string;
}

interface RequestFrameMessage {
	type: "request-frame";
}

type WorkerMessage =
	| ReadyMessage
	| FrameRenderedMessage
	| FrameQueuedMessage
	| DecodedFrame
	| ErrorMessage
	| RequestFrameMessage;

export function createImageDataWS(
	url: string,
	onmessage: (data: FrameData) => void,
	onRequestFrame?: () => void,
): [
	Omit<WebSocket, "onmessage">,
	() => boolean,
	() => boolean,
	CanvasControls,
] {
	const [isConnected, setIsConnected] = createSignal(false);
	const [isWorkerReady, setIsWorkerReady] = createSignal(false);
	const ws = createWS(url);

	const worker = new FrameWorker();
	let pendingFrame: ArrayBuffer | null = null;
	let isProcessing = false;
	let nextFrame: ArrayBuffer | null = null;

	let producer: Producer | null = null;
	if (SAB_SUPPORTED) {
		try {
			const init = createSharedFrameBuffer(FRAME_BUFFER_CONFIG);
			producer = createProducer(init);
			worker.postMessage({
				type: "init-shared-buffer",
				buffer: init.buffer,
			});
		} catch (e) {
			console.error(
				"[socket] SharedArrayBuffer allocation failed, falling back to non-SAB mode:",
				e instanceof Error ? e.message : e,
			);
			producer = null;
		}
	}

	const [hasRenderedFrame, setHasRenderedFrame] = createSignal(false);
	let isCleanedUp = false;

	let directCanvas: HTMLCanvasElement | null = null;
	let directCtx: CanvasRenderingContext2D | null = null;
	let strideWorker: Worker | null = null;

	let cachedDirectImageData: ImageData | null = null;
	let cachedDirectWidth = 0;
	let cachedDirectHeight = 0;

	let cachedStrideImageData: ImageData | null = null;
	let cachedStrideWidth = 0;
	let cachedStrideHeight = 0;

	let mainThreadWebGPU: WebGPURenderer | null = null;
	let mainThreadWebGPUInitializing = false;
	let pendingNv12Frame: ArrayBuffer | null = null;

	let lastRenderedFrameData: {
		data: Uint8ClampedArray;
		width: number;
		height: number;
		yStride: number;
		isNv12: boolean;
	} | null = null;

	function storeRenderedFrame(
		frameData: Uint8ClampedArray,
		width: number,
		height: number,
		yStride: number,
		isNv12: boolean,
	) {
		if (
			lastRenderedFrameData &&
			lastRenderedFrameData.data.length === frameData.length
		) {
			lastRenderedFrameData.data.set(frameData);
			lastRenderedFrameData.width = width;
			lastRenderedFrameData.height = height;
			lastRenderedFrameData.yStride = yStride;
			lastRenderedFrameData.isNv12 = isNv12;
		} else {
			lastRenderedFrameData = {
				data: new Uint8ClampedArray(frameData),
				width,
				height,
				yStride,
				isNv12,
			};
		}
		if (!hasRenderedFrame()) {
			setHasRenderedFrame(true);
		}
	}

	function cleanup() {
		if (isCleanedUp) return;
		isCleanedUp = true;

		if (producer) {
			producer.signalShutdown();
			producer = null;
		}

		worker.onmessage = null;
		worker.terminate();

		if (strideWorker) {
			strideWorker.onmessage = null;
			strideWorker.terminate();
			strideWorker = null;
		}

		pendingFrame = null;
		nextFrame = null;
		isProcessing = false;

		if (mainThreadWebGPU) {
			disposeWebGPU(mainThreadWebGPU);
			mainThreadWebGPU = null;
		}

		pendingNv12Frame = null;
		cachedDirectImageData = null;
		cachedDirectWidth = 0;
		cachedDirectHeight = 0;
		cachedStrideImageData = null;
		cachedStrideWidth = 0;
		cachedStrideHeight = 0;

		lastRenderedFrameData = null;

		setIsConnected(false);
	}

	function renderPendingNv12Frame() {
		if (!pendingNv12Frame || !mainThreadWebGPU || !directCanvas) return;

		const buffer = pendingNv12Frame;
		pendingNv12Frame = null;

		const NV12_MAGIC = 0x4e563132;
		if (buffer.byteLength < 28) return;

		const formatCheck = new DataView(buffer, buffer.byteLength - 4, 4);
		if (formatCheck.getUint32(0, true) !== NV12_MAGIC) return;

		const metadataOffset = buffer.byteLength - 28;
		const meta = new DataView(buffer, metadataOffset, 28);
		const yStride = meta.getUint32(0, true);
		const height = meta.getUint32(4, true);
		const width = meta.getUint32(8, true);

		if (width > 0 && height > 0) {
			const ySize = yStride * height;
			const uvSize = yStride * (height / 2);
			const totalSize = ySize + uvSize;

			const frameData = new Uint8ClampedArray(buffer, 0, totalSize);

			if (directCanvas.width !== width || directCanvas.height !== height) {
				directCanvas.width = width;
				directCanvas.height = height;
			}

			renderNv12FrameWebGPU(
				mainThreadWebGPU,
				frameData,
				width,
				height,
				yStride,
			);

			storeRenderedFrame(frameData, width, height, yStride, true);
			onmessage({ width, height });
		}
	}

	function renderPendingFrameCanvas2D() {
		if (!pendingNv12Frame || !directCanvas || !directCtx) return;

		const buffer = pendingNv12Frame;
		pendingNv12Frame = null;

		const NV12_MAGIC = 0x4e563132;
		if (buffer.byteLength < 28) return;

		const formatCheck = new DataView(buffer, buffer.byteLength - 4, 4);
		if (formatCheck.getUint32(0, true) !== NV12_MAGIC) return;

		const metadataOffset = buffer.byteLength - 28;
		const meta = new DataView(buffer, metadataOffset, 28);
		const yStride = meta.getUint32(0, true);
		const height = meta.getUint32(4, true);
		const width = meta.getUint32(8, true);

		if (width > 0 && height > 0) {
			const ySize = yStride * height;
			const uvSize = yStride * (height / 2);
			const totalSize = ySize + uvSize;

			const frameData = new Uint8ClampedArray(buffer, 0, totalSize);

			if (directCanvas.width !== width || directCanvas.height !== height) {
				directCanvas.width = width;
				directCanvas.height = height;
			}

			const rgba = convertNv12ToRgbaMainThread(
				frameData,
				width,
				height,
				yStride,
			);
			const imageData = new ImageData(
				new Uint8ClampedArray(rgba),
				width,
				height,
			);
			directCtx.putImageData(imageData, 0, 0);

			storeRenderedFrame(frameData, width, height, yStride, true);
			onmessage({ width, height });
		}
	}

	const canvasControls: CanvasControls = {
		initCanvas: (canvas: OffscreenCanvas) => {
			worker.postMessage({ type: "init-canvas", canvas }, [canvas]);
		},
		resizeCanvas: (width: number, height: number) => {
			worker.postMessage({ type: "resize", width, height });
		},
		hasRenderedFrame,
		initDirectCanvas: (canvas: HTMLCanvasElement) => {
			const isNewCanvas = directCanvas !== canvas;

			if (isNewCanvas && directCanvas) {
				if (mainThreadWebGPU) {
					disposeWebGPU(mainThreadWebGPU);
					mainThreadWebGPU = null;
				}
				directCtx = null;
				mainThreadWebGPUInitializing = false;
			}

			directCanvas = canvas;

			if (!mainThreadWebGPUInitializing && !mainThreadWebGPU) {
				mainThreadWebGPUInitializing = true;
				isWebGPUSupported().then((supported) => {
					if (supported && directCanvas) {
						initWebGPU(directCanvas as unknown as OffscreenCanvas)
							.then((renderer) => {
								mainThreadWebGPU = renderer;
								mainThreadWebGPUInitializing = false;
								if (pendingNv12Frame && directCanvas) {
									renderPendingNv12Frame();
								}
								onRequestFrame?.();
							})
							.catch((e) => {
								mainThreadWebGPUInitializing = false;
								console.error("[Socket] Main thread WebGPU init failed:", e);
								directCtx =
									directCanvas?.getContext("2d", { alpha: false }) ?? null;
								if (pendingNv12Frame && directCanvas && directCtx) {
									renderPendingFrameCanvas2D();
								}
								onRequestFrame?.();
							});
					} else {
						mainThreadWebGPUInitializing = false;
						directCtx =
							directCanvas?.getContext("2d", { alpha: false }) ?? null;
						if (pendingNv12Frame && directCanvas && directCtx) {
							renderPendingFrameCanvas2D();
						}
						onRequestFrame?.();
					}
				});
			}

			strideWorker = new StrideCorrectionWorker();
			strideWorker.onmessage = (e: MessageEvent<StrideCorrectionResponse>) => {
				if (e.data.type !== "corrected" || !directCanvas || !directCtx) return;

				const { buffer, width, height } = e.data;
				if (directCanvas.width !== width || directCanvas.height !== height) {
					directCanvas.width = width;
					directCanvas.height = height;
				}

				const frameData = new Uint8ClampedArray(buffer);
				if (
					!cachedStrideImageData ||
					cachedStrideWidth !== width ||
					cachedStrideHeight !== height
				) {
					cachedStrideImageData = new ImageData(width, height);
					cachedStrideWidth = width;
					cachedStrideHeight = height;
				}
				cachedStrideImageData.data.set(frameData);
				directCtx.putImageData(cachedStrideImageData, 0, 0);

				storeRenderedFrame(
					cachedStrideImageData.data,
					width,
					height,
					width * 4,
					false,
				);
				onmessage({ width, height });
			};
		},
		resetFrameState: () => {
			worker.postMessage({ type: "reset-frame-state" });
		},
		captureFrame: async () => {
			if (!lastRenderedFrameData) {
				return null;
			}
			const { data, width, height, yStride, isNv12 } = lastRenderedFrameData;
			let imageData: ImageData;
			if (isNv12) {
				const rgba = convertNv12ToRgbaMainThread(data, width, height, yStride);
				imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
			} else {
				imageData = new ImageData(new Uint8ClampedArray(data), width, height);
			}
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return null;
			}
			ctx.putImageData(imageData, 0, 0);
			return new Promise<Blob | null>((resolve) => {
				canvas.toBlob((blob) => resolve(blob), "image/png");
			});
		},
	};

	worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
		if (e.data.type === "ready") {
			setIsWorkerReady(true);
			return;
		}

		if (e.data.type === "error") {
			console.error("[FrameWorker]", e.data.message);
			isProcessing = false;
			processNextFrame();
			return;
		}

		if (e.data.type === "frame-queued") {
			const { width, height } = e.data;
			onmessage({ width, height });
			isProcessing = false;
			processNextFrame();
			return;
		}

		if (e.data.type === "frame-rendered") {
			const { width, height } = e.data;
			onmessage({ width, height });
			actualRendersCount++;
			if (!hasRenderedFrame()) {
				setHasRenderedFrame(true);
			}
			return;
		}

		if (e.data.type === "request-frame") {
			onRequestFrame?.();
			return;
		}

		if (e.data.type === "decoded") {
			const { bitmap, width, height } = e.data;
			onmessage({ width, height, bitmap });
			isProcessing = false;
			processNextFrame();
		}
	};

	function processNextFrame() {
		if (isProcessing) return;

		const buffer = nextFrame || pendingFrame;
		if (!buffer) return;

		if (nextFrame) {
			nextFrame = null;
		} else {
			pendingFrame = null;
		}

		isProcessing = true;

		if (producer) {
			const written = producer.write(buffer);
			if (!written) {
				worker.postMessage({ type: "frame", buffer }, [buffer]);
			}
		} else {
			worker.postMessage({ type: "frame", buffer }, [buffer]);
		}
	}

	ws.addEventListener("open", () => {
		setIsConnected(true);
	});

	ws.addEventListener("close", () => {
		cleanup();
	});

	ws.addEventListener("error", () => {
		cleanup();
	});

	let lastFrameTime = 0;
	let frameCount = 0;
	let frameTimeSum = 0;
	let totalBytesReceived = 0;
	let lastLogTime = 0;
	let framesReceived = 0;
	let framesDropped = 0;
	let framesSentToWorker = 0;
	let actualRendersCount = 0;
	let renderFrameCount = 0;
	let minFrameTime = Number.MAX_VALUE;
	let maxFrameTime = 0;

	const getLocalFpsStats = (): FpsStats => ({
		fps:
			frameCount > 0 && frameTimeSum > 0
				? 1000 / (frameTimeSum / frameCount)
				: 0,
		renderFps: actualRendersCount,
		avgFrameMs: frameCount > 0 ? frameTimeSum / frameCount : 0,
		minFrameMs: minFrameTime === Number.MAX_VALUE ? 0 : minFrameTime,
		maxFrameMs: maxFrameTime,
		mbPerSec: totalBytesReceived / 1_000_000,
	});

	globalFpsStatsGetter = getLocalFpsStats;
	(globalThis as Record<string, unknown>).__capFpsStats = getLocalFpsStats;

	const NV12_MAGIC = 0x4e563132;

	ws.binaryType = "arraybuffer";
	ws.onmessage = (event) => {
		const buffer = event.data as ArrayBuffer;
		const now = performance.now();
		totalBytesReceived += buffer.byteLength;
		framesReceived++;

		let isNv12Format = false;
		if (buffer.byteLength >= 28) {
			const formatCheck = new DataView(buffer, buffer.byteLength - 4, 4);
			isNv12Format = formatCheck.getUint32(0, true) === NV12_MAGIC;
		}

		if (lastFrameTime > 0) {
			const delta = now - lastFrameTime;
			frameCount++;
			frameTimeSum += delta;
			minFrameTime = Math.min(minFrameTime, delta);
			maxFrameTime = Math.max(maxFrameTime, delta);

			if (frameCount % 60 === 0) {
				const avgDelta = frameTimeSum / 60;
				const elapsedSec = (now - lastLogTime) / 1000;
				const mbPerSec = totalBytesReceived / 1_000_000 / elapsedSec;
				const recvFps = framesReceived / elapsedSec;
				const sentFps = framesSentToWorker / elapsedSec;
				const actualFps = actualRendersCount / elapsedSec;
				const dropRate =
					framesReceived > 0 ? (framesDropped / framesReceived) * 100 : 0;

				console.log(
					`[Frame] recv: ${recvFps.toFixed(1)}/s, sent: ${sentFps.toFixed(1)}/s, ACTUAL: ${actualFps.toFixed(1)}/s, dropped: ${dropRate.toFixed(0)}%, delta: ${avgDelta.toFixed(1)}ms, ${mbPerSec.toFixed(1)} MB/s, ${isNv12Format ? "NV12" : "RGBA"}`,
				);

				frameCount = 0;
				frameTimeSum = 0;
				totalBytesReceived = 0;
				lastLogTime = now;
				framesReceived = 0;
				framesDropped = 0;
				framesSentToWorker = 0;
				actualRendersCount = 0;
				minFrameTime = Number.MAX_VALUE;
				maxFrameTime = 0;
			}
		} else {
			lastLogTime = now;
		}
		lastFrameTime = now;

		if (isNv12Format) {
			if (mainThreadWebGPU && directCanvas) {
				const metadataOffset = buffer.byteLength - 28;
				const meta = new DataView(buffer, metadataOffset, 28);
				const yStride = meta.getUint32(0, true);
				const height = meta.getUint32(4, true);
				const width = meta.getUint32(8, true);
				const frameNumber = meta.getUint32(12, true);

				if (width > 0 && height > 0) {
					const ySize = yStride * height;
					const uvSize = yStride * (height / 2);
					const totalSize = ySize + uvSize;

					const frameData = new Uint8ClampedArray(buffer, 0, totalSize);

					if (directCanvas.width !== width || directCanvas.height !== height) {
						directCanvas.width = width;
						directCanvas.height = height;
					}

					renderNv12FrameWebGPU(
						mainThreadWebGPU,
						frameData,
						width,
						height,
						yStride,
					);
					actualRendersCount++;
					renderFrameCount++;

					storeRenderedFrame(frameData, width, height, yStride, true);
					onmessage({ width, height });
				}
				return;
			}

			if (mainThreadWebGPUInitializing || !directCanvas) {
				pendingNv12Frame = buffer;
				const metadataOffset = buffer.byteLength - 28;
				const meta = new DataView(buffer, metadataOffset, 28);
				const height = meta.getUint32(4, true);
				const width = meta.getUint32(8, true);
				if (width > 0 && height > 0) {
					onmessage({ width, height });
				}
				return;
			}

			if (directCanvas && directCtx) {
				if (!directCanvas.isConnected) {
					const domCanvas = document.getElementById(
						"canvas",
					) as HTMLCanvasElement | null;
					if (domCanvas && domCanvas !== directCanvas) {
						directCanvas = domCanvas;
						directCtx = domCanvas.getContext("2d", { alpha: false });
						if (!directCtx) {
							console.error(
								"[Socket] Failed to get 2D context from DOM canvas",
							);
							return;
						}
					} else {
						return;
					}
				}

				const metadataOffset = buffer.byteLength - 28;
				const meta = new DataView(buffer, metadataOffset, 28);
				const yStride = meta.getUint32(0, true);
				const height = meta.getUint32(4, true);
				const width = meta.getUint32(8, true);
				const frameNumber = meta.getUint32(12, true);

				if (width > 0 && height > 0) {
					const ySize = yStride * height;
					const uvSize = yStride * (height / 2);
					const totalSize = ySize + uvSize;

					const nv12Data = new Uint8ClampedArray(buffer, 0, totalSize);
					const rgbaData = convertNv12ToRgbaMainThread(
						nv12Data,
						width,
						height,
						yStride,
					);

					if (directCanvas.width !== width || directCanvas.height !== height) {
						directCanvas.width = width;
						directCanvas.height = height;
					}

					if (
						!cachedDirectImageData ||
						cachedDirectWidth !== width ||
						cachedDirectHeight !== height
					) {
						cachedDirectImageData = new ImageData(width, height);
						cachedDirectWidth = width;
						cachedDirectHeight = height;
					}
					cachedDirectImageData.data.set(rgbaData);
					directCtx.putImageData(cachedDirectImageData, 0, 0);

					storeRenderedFrame(nv12Data, width, height, yStride, true);
					actualRendersCount++;
					renderFrameCount++;

					onmessage({ width, height });
				}
				return;
			}

			if (isProcessing) {
				framesDropped++;
				nextFrame = buffer;
			} else {
				framesSentToWorker++;
				pendingFrame = buffer;
				processNextFrame();
			}
			return;
		}

		if (mainThreadWebGPU && directCanvas && buffer.byteLength >= 24) {
			const metadataOffset = buffer.byteLength - 24;
			const meta = new DataView(buffer, metadataOffset, 24);
			const strideBytes = meta.getUint32(0, true);
			const height = meta.getUint32(4, true);
			const width = meta.getUint32(8, true);

			if (width > 0 && height > 0) {
				const frameDataSize = strideBytes * height;
				const frameData = new Uint8ClampedArray(buffer, 0, frameDataSize);

				if (directCanvas.width !== width || directCanvas.height !== height) {
					directCanvas.width = width;
					directCanvas.height = height;
				}

				renderFrameWebGPU(
					mainThreadWebGPU,
					frameData,
					width,
					height,
					strideBytes,
				);
				actualRendersCount++;
				renderFrameCount++;

				storeRenderedFrame(frameData, width, height, strideBytes, false);
				onmessage({ width, height });
			}
			return;
		}

		if (directCanvas && directCtx && strideWorker) {
			if (buffer.byteLength >= 24) {
				const metadataOffset = buffer.byteLength - 24;
				const meta = new DataView(buffer, metadataOffset, 24);
				const strideBytes = meta.getUint32(0, true);
				const height = meta.getUint32(4, true);
				const width = meta.getUint32(8, true);

				if (width > 0 && height > 0) {
					const expectedRowBytes = width * 4;
					const needsStrideCorrection = strideBytes !== expectedRowBytes;

					if (lastFrameTime > 0) {
						const delta = now - lastFrameTime;
						frameCount++;
						frameTimeSum += delta;
						minFrameTime = Math.min(minFrameTime, delta);
						maxFrameTime = Math.max(maxFrameTime, delta);
						if (frameCount % 60 === 0) {
							const avgDelta = frameTimeSum / 60;
							const elapsedSec = (now - lastLogTime) / 1000;
							const mbPerSec = totalBytesReceived / 1_000_000 / elapsedSec;
							const actualRenderFps = renderFrameCount / elapsedSec;
							console.log(
								`[Frame] recv_fps: ${(1000 / avgDelta).toFixed(1)}, render_fps: ${actualRenderFps.toFixed(1)}, mb/s: ${mbPerSec.toFixed(1)}, frame_ms: ${avgDelta.toFixed(1)} (min: ${minFrameTime.toFixed(1)}, max: ${maxFrameTime.toFixed(1)}), size: ${(buffer.byteLength / 1024).toFixed(0)}KB, format: ${isNv12Format ? "NV12" : "RGBA"}`,
							);
							frameTimeSum = 0;
							totalBytesReceived = 0;
							lastLogTime = now;
							renderFrameCount = 0;
							minFrameTime = Number.MAX_VALUE;
							maxFrameTime = 0;
						}
					} else {
						lastLogTime = now;
					}
					lastFrameTime = now;

					if (!needsStrideCorrection) {
						const frameData = new Uint8ClampedArray(
							buffer,
							0,
							expectedRowBytes * height,
						);

						if (
							directCanvas.width !== width ||
							directCanvas.height !== height
						) {
							directCanvas.width = width;
							directCanvas.height = height;
						}

						if (
							!cachedDirectImageData ||
							cachedDirectWidth !== width ||
							cachedDirectHeight !== height
						) {
							cachedDirectImageData = new ImageData(width, height);
							cachedDirectWidth = width;
							cachedDirectHeight = height;
						}
						cachedDirectImageData.data.set(frameData);
						directCtx.putImageData(cachedDirectImageData, 0, 0);

						storeRenderedFrame(
							cachedDirectImageData.data,
							width,
							height,
							width * 4,
							false,
						);
						renderFrameCount++;

						onmessage({ width, height });
					} else {
						strideWorker.postMessage(
							{
								type: "correct-stride",
								buffer,
								strideBytes,
								width,
								height,
							},
							[buffer],
						);
					}
				}
			}
			return;
		}

		if (isProcessing) {
			nextFrame = buffer;
		} else {
			pendingFrame = buffer;
			processNextFrame();
		}
	};

	return [ws, isConnected, isWorkerReady, canvasControls];
}

export function createLazySignal<T>() {
	let res: ((value: T) => void) | undefined;

	const [value, { mutate: setValue }] = createResource(
		() =>
			new Promise<T>((r) => {
				res = r;
			}),
	);

	return [
		value,
		(value: T) => {
			if (res) {
				res(value);
				res = undefined;
			} else {
				setValue(() => value);
			}
		},
	] as const;
}
