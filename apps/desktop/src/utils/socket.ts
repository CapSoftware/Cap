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
	renderFrameWebGPU,
	renderNv12FrameWebGPU,
	type WebGPURenderer,
	type WebGPURenderTiming,
} from "./webgpu-renderer";

const SAB_SUPPORTED = isSharedArrayBufferSupported();
// Preview frames are capped at 960x540 RGBA (~2.1MB) by the Rust sender, so
// 4MB slots leave 2x headroom; oversized frames fall back to postMessage.
const FRAME_BUFFER_CONFIG: SharedFrameBufferConfig = {
	slotCount: 4,
	slotSize: 4 * 1024 * 1024,
};

let mainThreadNv12Buffer: Uint8ClampedArray | null = null;
let mainThreadNv12BufferSize = 0;

const NV12_VIDEO_MAGIC = 0x4e563132;
const NV12_FULL_MAGIC = 0x4e563146;
const NV12_METADATA_SIZE = 28;

type Nv12Metadata = {
	yStride: number;
	height: number;
	width: number;
	fullRange: boolean;
};

function readNv12Metadata(buffer: ArrayBuffer): Nv12Metadata | null {
	if (buffer.byteLength < NV12_METADATA_SIZE) return null;

	const formatCheck = new DataView(buffer, buffer.byteLength - 4, 4);
	const magic = formatCheck.getUint32(0, true);
	if (magic !== NV12_VIDEO_MAGIC && magic !== NV12_FULL_MAGIC) return null;

	const metadataOffset = buffer.byteLength - NV12_METADATA_SIZE;
	const meta = new DataView(buffer, metadataOffset, NV12_METADATA_SIZE);
	const yStride = meta.getUint32(0, true);
	const height = meta.getUint32(4, true);
	const width = meta.getUint32(8, true);

	const ySize = yStride * height;
	const uvSize = yStride * Math.floor(height / 2);
	const totalSize = ySize + uvSize;
	if (
		yStride === 0 ||
		height === 0 ||
		width === 0 ||
		buffer.byteLength - NV12_METADATA_SIZE < totalSize
	) {
		return null;
	}

	return {
		yStride,
		height,
		width,
		fullRange: magic === NV12_FULL_MAGIC,
	};
}

export type FpsStats = {
	fps: number;
	renderFps: number;
	avgFrameMs: number;
	minFrameMs: number;
	maxFrameMs: number;
	mbPerSec: number;
	avgRenderMs: number;
	maxRenderMs: number;
	avgUploadMs: number;
	maxUploadMs: number;
	avgReceiveToDisplayMs: number;
	maxReceiveToDisplayMs: number;
	sharedBufferWrites: number;
	sharedBufferFallbacks: number;
	frameCount: number;
	renderCount: number;
	uploadCount: number;
	receiveToDisplayCount: number;
	windowMs: number;
	transportMode: "webgpu" | "canvas2d" | "worker" | "pending";
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
	fullRange = false,
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
		const uvRowOffset = (row >> 1) * uvStride;
		const rgbaRowOffset = row * width * 4;

		for (let col = 0; col < width; col += 2) {
			const uvCol = (col >> 1) * 2;
			const u = uvPlane[uvRowOffset + uvCol] - 128;
			const v = uvPlane[uvRowOffset + uvCol + 1] - 128;
			const d = u;
			const e = v;

			const y0 = yPlane[yRowOffset + col];
			let r: number;
			let g: number;
			let b: number;
			if (fullRange) {
				r = y0 + ((359 * e + 128) >> 8);
				g = y0 - ((88 * d + 183 * e + 128) >> 8);
				b = y0 + ((454 * d + 128) >> 8);
			} else {
				const c0 = 298 * (y0 - 16);
				r = (c0 + 409 * e + 128) >> 8;
				g = (c0 - 100 * d - 208 * e + 128) >> 8;
				b = (c0 + 516 * d + 128) >> 8;
			}

			r = r < 0 ? 0 : r > 255 ? 255 : r;
			g = g < 0 ? 0 : g > 255 ? 255 : g;
			b = b < 0 ? 0 : b > 255 ? 255 : b;

			const rgbaOffset = rgbaRowOffset + col * 4;
			rgba[rgbaOffset] = r;
			rgba[rgbaOffset + 1] = g;
			rgba[rgbaOffset + 2] = b;
			rgba[rgbaOffset + 3] = 255;

			const nextCol = col + 1;
			if (nextCol < width) {
				const y1 = yPlane[yRowOffset + nextCol];
				let nextR: number;
				let nextG: number;
				let nextB: number;
				if (fullRange) {
					nextR = y1 + ((359 * e + 128) >> 8);
					nextG = y1 - ((88 * d + 183 * e + 128) >> 8);
					nextB = y1 + ((454 * d + 128) >> 8);
				} else {
					const c1 = 298 * (y1 - 16);
					nextR = (c1 + 409 * e + 128) >> 8;
					nextG = (c1 - 100 * d - 208 * e + 128) >> 8;
					nextB = (c1 + 516 * d + 128) >> 8;
				}

				nextR = nextR < 0 ? 0 : nextR > 255 ? 255 : nextR;
				nextG = nextG < 0 ? 0 : nextG > 255 ? 255 : nextG;
				nextB = nextB < 0 ? 0 : nextB > 255 ? 255 : nextB;

				const nextRgbaOffset = rgbaOffset + 4;
				rgba[nextRgbaOffset] = nextR;
				rgba[nextRgbaOffset + 1] = nextG;
				rgba[nextRgbaOffset + 2] = nextB;
				rgba[nextRgbaOffset + 3] = 255;
			}
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
	drawLatestFrameToCanvas: (canvas: HTMLCanvasElement) => boolean;
	dispose: () => void;
};

export type ImageDataWSOptions = {
	powerPreference?: GPUPowerPreference;
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
	options: ImageDataWSOptions = {},
): [
	Omit<WebSocket, "onmessage">,
	() => boolean,
	() => boolean,
	CanvasControls,
] {
	const [isConnected, setIsConnected] = createSignal(false);
	const [isWorkerReady, setIsWorkerReady] = createSignal(false);
	const ws = createWS(url);

	// The frame worker (and its SharedArrayBuffer) only exists for the
	// OffscreenCanvas path; the direct-canvas consumers never need it, so it
	// is created lazily to avoid a worker + SAB reservation per window.
	let worker: Worker | null = null;
	let workerCanvasMode = false;
	let pendingFrame: ArrayBuffer | null = null;
	let isProcessing = false;
	let isProcessingSharedFrame = false;
	let nextFrame: ArrayBuffer | null = null;

	let producer: Producer | null = null;

	function ensureWorker(): Worker {
		if (worker) return worker;
		worker = new FrameWorker();
		worker.onmessage = handleWorkerMessage;
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
		return worker;
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
	let pendingNv12Frame: { buffer: ArrayBuffer; receivedAt: number } | null =
		null;
	let pendingRgbaFrame: { buffer: ArrayBuffer; receivedAt: number } | null =
		null;
	let pendingNv12RafId: number | null = null;
	let pendingRgbaRafId: number | null = null;
	let pendingCanvas2DNv12RafId: number | null = null;
	let pendingCanvas2DRgbaFrame: {
		buffer: ArrayBuffer;
		receivedAt: number;
	} | null = null;
	let pendingCanvas2DRgbaRafId: number | null = null;

	let lastRenderedFrameData: {
		data: Uint8ClampedArray;
		width: number;
		height: number;
		yStride: number;
		isNv12: boolean;
		nv12FullRange: boolean;
	} | null = null;

	let mirrorCanvas: HTMLCanvasElement | null = null;
	let mirrorCtx: CanvasRenderingContext2D | null = null;
	let mirrorImageData: ImageData | null = null;

	function storeRenderedFrame(
		frameData: Uint8ClampedArray,
		width: number,
		height: number,
		yStride: number,
		isNv12: boolean,
		nv12FullRange = false,
	) {
		lastRenderedFrameData = {
			data: frameData,
			width,
			height,
			yStride,
			isNv12,
			nv12FullRange,
		};
		if (!hasRenderedFrame()) {
			setHasRenderedFrame(true);
		}
	}

	function cleanup() {
		if (isCleanedUp) return;
		isCleanedUp = true;

		ws.onmessage = null;

		if (producer) {
			producer.signalShutdown();
			producer = null;
		}

		if (worker) {
			worker.onmessage = null;
			worker.terminate();
			worker = null;
		}

		if (strideWorker) {
			strideWorker.onmessage = null;
			strideWorker.terminate();
			strideWorker = null;
		}

		pendingFrame = null;
		nextFrame = null;
		isProcessing = false;
		isProcessingSharedFrame = false;

		if (mainThreadWebGPU) {
			disposeWebGPU(mainThreadWebGPU);
			mainThreadWebGPU = null;
		}

		mainThreadWebGPUInitializing = false;
		pendingNv12Frame = null;
		pendingRgbaFrame = null;
		pendingCanvas2DRgbaFrame = null;
		if (pendingNv12RafId !== null) {
			cancelAnimationFrame(pendingNv12RafId);
			pendingNv12RafId = null;
		}
		if (pendingRgbaRafId !== null) {
			cancelAnimationFrame(pendingRgbaRafId);
			pendingRgbaRafId = null;
		}
		if (pendingCanvas2DNv12RafId !== null) {
			cancelAnimationFrame(pendingCanvas2DNv12RafId);
			pendingCanvas2DNv12RafId = null;
		}
		if (pendingCanvas2DRgbaRafId !== null) {
			cancelAnimationFrame(pendingCanvas2DRgbaRafId);
			pendingCanvas2DRgbaRafId = null;
		}
		mainThreadNv12Buffer = null;
		mainThreadNv12BufferSize = 0;
		cachedDirectImageData = null;
		cachedDirectWidth = 0;
		cachedDirectHeight = 0;
		cachedStrideImageData = null;
		cachedStrideWidth = 0;
		cachedStrideHeight = 0;
		directCanvas = null;
		directCtx = null;

		lastRenderedFrameData = null;
		mirrorCanvas = null;
		mirrorCtx = null;
		mirrorImageData = null;
		globalFpsStatsGetter =
			globalFpsStatsGetter === getLocalFpsStats ? null : globalFpsStatsGetter;
		if (
			(globalThis as Record<string, unknown>).__capFpsStats === getLocalFpsStats
		) {
			delete (globalThis as Record<string, unknown>).__capFpsStats;
		}

		setIsConnected(false);
	}

	function renderPendingNv12Frame() {
		if (!pendingNv12Frame || !mainThreadWebGPU || !directCanvas) return;

		const { buffer, receivedAt } = pendingNv12Frame;
		pendingNv12Frame = null;

		const metadata = readNv12Metadata(buffer);
		if (!metadata) return;

		const { yStride, height, width, fullRange } = metadata;

		if (width > 0 && height > 0) {
			const ySize = yStride * height;
			const uvSize = yStride * (height / 2);
			const totalSize = ySize + uvSize;

			const frameData = new Uint8ClampedArray(buffer, 0, totalSize);
			const renderStart = performance.now();

			if (directCanvas.width !== width || directCanvas.height !== height) {
				directCanvas.width = width;
				directCanvas.height = height;
			}

			const timing = renderNv12FrameWebGPU(
				mainThreadWebGPU,
				frameData,
				width,
				height,
				yStride,
				fullRange,
			);

			storeRenderedFrame(frameData, width, height, yStride, true, fullRange);
			recordRender(
				performance.now() - renderStart,
				"webgpu",
				timing,
				receivedAt,
			);
			onmessage({ width, height });
		}
	}

	function schedulePendingNv12Frame(buffer: ArrayBuffer, receivedAt: number) {
		pendingNv12Frame = { buffer, receivedAt };
		if (pendingNv12RafId !== null) return;

		pendingNv12RafId = requestAnimationFrame(() => {
			pendingNv12RafId = null;
			renderPendingNv12Frame();
		});
	}

	function renderPendingRgbaFrame() {
		if (!pendingRgbaFrame || !mainThreadWebGPU || !directCanvas) return;

		const { buffer, receivedAt } = pendingRgbaFrame;
		pendingRgbaFrame = null;

		if (buffer.byteLength < 24) return;

		const metadataOffset = buffer.byteLength - 24;
		const meta = new DataView(buffer, metadataOffset, 24);
		const strideBytes = meta.getUint32(0, true);
		const height = meta.getUint32(4, true);
		const width = meta.getUint32(8, true);

		if (width > 0 && height > 0) {
			const frameDataSize = strideBytes * height;
			if (strideBytes === 0 || buffer.byteLength - 24 < frameDataSize) return;

			const frameData = new Uint8ClampedArray(buffer, 0, frameDataSize);
			const renderStart = performance.now();

			if (directCanvas.width !== width || directCanvas.height !== height) {
				directCanvas.width = width;
				directCanvas.height = height;
			}

			const timing = renderFrameWebGPU(
				mainThreadWebGPU,
				frameData,
				width,
				height,
				strideBytes,
			);

			storeRenderedFrame(frameData, width, height, strideBytes, false);
			recordRender(
				performance.now() - renderStart,
				"webgpu",
				timing,
				receivedAt,
			);
			onmessage({ width, height });
		}
	}

	function schedulePendingRgbaFrame(buffer: ArrayBuffer, receivedAt: number) {
		pendingRgbaFrame = { buffer, receivedAt };
		if (pendingRgbaRafId !== null) return;

		pendingRgbaRafId = requestAnimationFrame(() => {
			pendingRgbaRafId = null;
			renderPendingRgbaFrame();
		});
	}

	function renderNv12FrameCanvas2D(
		frameData: Uint8ClampedArray,
		width: number,
		height: number,
		yStride: number,
		fullRange: boolean,
		receivedAt?: number,
	) {
		if (!directCanvas || !directCtx) return;

		const renderStart = performance.now();

		if (directCanvas.width !== width || directCanvas.height !== height) {
			directCanvas.width = width;
			directCanvas.height = height;
		}

		const rgba = convertNv12ToRgbaMainThread(
			frameData,
			width,
			height,
			yStride,
			fullRange,
		);

		if (
			!cachedDirectImageData ||
			cachedDirectWidth !== width ||
			cachedDirectHeight !== height
		) {
			cachedDirectImageData = new ImageData(width, height);
			cachedDirectWidth = width;
			cachedDirectHeight = height;
		}
		cachedDirectImageData.data.set(rgba);
		directCtx.putImageData(cachedDirectImageData, 0, 0);

		storeRenderedFrame(frameData, width, height, yStride, true, fullRange);
		recordRender(
			performance.now() - renderStart,
			"canvas2d",
			undefined,
			receivedAt,
		);
		onmessage({ width, height });
	}

	function renderPendingFrameCanvas2D() {
		if (!pendingNv12Frame || !directCanvas || !directCtx) return;

		const { buffer, receivedAt } = pendingNv12Frame;
		pendingNv12Frame = null;

		const metadata = readNv12Metadata(buffer);
		if (!metadata) return;

		const { yStride, height, width, fullRange } = metadata;

		if (width > 0 && height > 0) {
			const ySize = yStride * height;
			const uvSize = yStride * (height / 2);
			const totalSize = ySize + uvSize;

			const frameData = new Uint8ClampedArray(buffer, 0, totalSize);
			renderNv12FrameCanvas2D(
				frameData,
				width,
				height,
				yStride,
				fullRange,
				receivedAt,
			);
		}
	}

	function schedulePendingNv12FrameCanvas2D(
		buffer: ArrayBuffer,
		receivedAt: number,
	) {
		pendingNv12Frame = { buffer, receivedAt };
		if (pendingCanvas2DNv12RafId !== null) return;

		pendingCanvas2DNv12RafId = requestAnimationFrame(() => {
			pendingCanvas2DNv12RafId = null;
			renderPendingFrameCanvas2D();
		});
	}

	function ensureStrideWorker(): Worker {
		if (strideWorker) return strideWorker;
		strideWorker = new StrideCorrectionWorker();
		strideWorker.onmessage = (e: MessageEvent<StrideCorrectionResponse>) => {
			if (e.data.type !== "corrected" || !directCanvas || !directCtx) return;

			const { buffer, width, height } = e.data;
			const renderStart = performance.now();
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
			recordRender(performance.now() - renderStart, "canvas2d");
			onmessage({ width, height });
		};
		return strideWorker;
	}

	function renderRgbaFrameCanvas2D(buffer: ArrayBuffer, receivedAt: number) {
		if (!directCanvas || !directCtx) return;
		if (buffer.byteLength < 24) return;

		const metadataOffset = buffer.byteLength - 24;
		const meta = new DataView(buffer, metadataOffset, 24);
		const strideBytes = meta.getUint32(0, true);
		const height = meta.getUint32(4, true);
		const width = meta.getUint32(8, true);

		if (width <= 0 || height <= 0) return;

		const expectedRowBytes = width * 4;
		const needsStrideCorrection = strideBytes !== expectedRowBytes;
		const availableLength = strideBytes * height;

		if (
			strideBytes === 0 ||
			strideBytes < expectedRowBytes ||
			buffer.byteLength - 24 < availableLength
		) {
			return;
		}

		if (!needsStrideCorrection) {
			const frameData = new Uint8ClampedArray(
				buffer,
				0,
				expectedRowBytes * height,
			);
			const renderStart = performance.now();

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
			cachedDirectImageData.data.set(frameData);
			directCtx.putImageData(cachedDirectImageData, 0, 0);

			storeRenderedFrame(
				cachedDirectImageData.data,
				width,
				height,
				width * 4,
				false,
			);
			recordRender(
				performance.now() - renderStart,
				"canvas2d",
				undefined,
				receivedAt,
			);
			onmessage({ width, height });
			return;
		}

		ensureStrideWorker().postMessage(
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

	function renderPendingRgbaFrameCanvas2D() {
		const pending = pendingCanvas2DRgbaFrame ?? pendingRgbaFrame;
		if (!pending) return;

		if (pendingCanvas2DRgbaFrame) {
			pendingCanvas2DRgbaFrame = null;
		} else {
			pendingRgbaFrame = null;
		}

		renderRgbaFrameCanvas2D(pending.buffer, pending.receivedAt);
	}

	function schedulePendingRgbaFrameCanvas2D(
		buffer: ArrayBuffer,
		receivedAt: number,
	) {
		pendingCanvas2DRgbaFrame = { buffer, receivedAt };
		if (pendingCanvas2DRgbaRafId !== null) return;

		pendingCanvas2DRgbaRafId = requestAnimationFrame(() => {
			pendingCanvas2DRgbaRafId = null;
			renderPendingRgbaFrameCanvas2D();
		});
	}

	const canvasControls: CanvasControls = {
		initCanvas: (canvas: OffscreenCanvas) => {
			if (isCleanedUp) return;
			workerCanvasMode = true;
			ensureWorker().postMessage({ type: "init-canvas", canvas }, [canvas]);
		},
		resizeCanvas: (width: number, height: number) => {
			if (isCleanedUp) return;
			worker?.postMessage({ type: "resize", width, height });
		},
		hasRenderedFrame,
		initDirectCanvas: (canvas: HTMLCanvasElement) => {
			if (isCleanedUp) return;

			const isNewCanvas = directCanvas !== canvas;

			if (isNewCanvas && directCanvas) {
				if (mainThreadWebGPU) {
					disposeWebGPU(mainThreadWebGPU);
					mainThreadWebGPU = null;
				}
				if (strideWorker) {
					strideWorker.onmessage = null;
					strideWorker.terminate();
					strideWorker = null;
				}
				directCtx = null;
				mainThreadWebGPUInitializing = false;
			}

			directCanvas = canvas;

			if (!mainThreadWebGPUInitializing && !mainThreadWebGPU) {
				mainThreadWebGPUInitializing = true;
				const maybeSupported =
					typeof navigator !== "undefined" && !!navigator.gpu;
				if (maybeSupported && directCanvas) {
					initWebGPU(
						directCanvas as unknown as OffscreenCanvas,
						options.powerPreference,
					)
						.then((renderer) => {
							if (isCleanedUp || !directCanvas) {
								disposeWebGPU(renderer);
								mainThreadWebGPUInitializing = false;
								return;
							}

							mainThreadWebGPU = renderer;
							mainThreadWebGPUInitializing = false;
							if (pendingNv12Frame && directCanvas) {
								renderPendingNv12Frame();
							}
							if (pendingRgbaFrame && directCanvas) {
								renderPendingRgbaFrame();
							}
							onRequestFrame?.();
						})
						.catch((e) => {
							if (isCleanedUp) {
								mainThreadWebGPUInitializing = false;
								return;
							}

							mainThreadWebGPUInitializing = false;
							console.error("[Socket] Main thread WebGPU init failed:", e);
							directCtx =
								directCanvas?.getContext("2d", { alpha: false }) ?? null;
							if (pendingNv12Frame && directCanvas && directCtx) {
								renderPendingFrameCanvas2D();
							}
							if (pendingRgbaFrame && directCanvas && directCtx) {
								renderPendingRgbaFrameCanvas2D();
							}
							onRequestFrame?.();
						});
				} else {
					mainThreadWebGPUInitializing = false;
					directCtx = directCanvas?.getContext("2d", { alpha: false }) ?? null;
					if (pendingNv12Frame && directCanvas && directCtx) {
						renderPendingFrameCanvas2D();
					}
					if (pendingRgbaFrame && directCanvas && directCtx) {
						renderPendingRgbaFrameCanvas2D();
					}
					onRequestFrame?.();
				}
			}
		},
		resetFrameState: () => {
			if (isCleanedUp) return;
			worker?.postMessage({ type: "reset-frame-state" });
		},
		captureFrame: async () => {
			if (isCleanedUp) {
				return null;
			}
			if (!lastRenderedFrameData) {
				return null;
			}
			const { data, width, height, yStride, isNv12, nv12FullRange } =
				lastRenderedFrameData;
			let imageData: ImageData;
			if (isNv12) {
				const rgba = convertNv12ToRgbaMainThread(
					data,
					width,
					height,
					yStride,
					nv12FullRange,
				);
				imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
			} else {
				const expectedRowBytes = width * 4;
				if (yStride === expectedRowBytes) {
					imageData = new ImageData(new Uint8ClampedArray(data), width, height);
				} else {
					const normalized = new Uint8ClampedArray(expectedRowBytes * height);
					for (let row = 0; row < height; row++) {
						const srcStart = row * yStride;
						const destStart = row * expectedRowBytes;
						normalized.set(
							data.subarray(srcStart, srcStart + expectedRowBytes),
							destStart,
						);
					}
					imageData = new ImageData(normalized, width, height);
				}
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
		drawLatestFrameToCanvas: (canvas: HTMLCanvasElement) => {
			if (isCleanedUp || !lastRenderedFrameData) return false;

			const { data, width, height, yStride, isNv12, nv12FullRange } =
				lastRenderedFrameData;
			if (width <= 0 || height <= 0) return false;

			if (canvas !== mirrorCanvas) {
				mirrorCanvas = canvas;
				mirrorCtx = canvas.getContext("2d", { alpha: false });
				mirrorImageData = null;
			}
			if (!mirrorCtx) return false;

			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
				mirrorImageData = null;
			}
			if (
				!mirrorImageData ||
				mirrorImageData.width !== width ||
				mirrorImageData.height !== height
			) {
				mirrorImageData = new ImageData(width, height);
			}

			if (isNv12) {
				const rgba = convertNv12ToRgbaMainThread(
					data,
					width,
					height,
					yStride,
					nv12FullRange,
				);
				mirrorImageData.data.set(rgba);
			} else {
				const expectedRowBytes = width * 4;
				if (yStride === expectedRowBytes) {
					mirrorImageData.data.set(data.subarray(0, expectedRowBytes * height));
				} else {
					for (let row = 0; row < height; row++) {
						const srcStart = row * yStride;
						const destStart = row * expectedRowBytes;
						mirrorImageData.data.set(
							data.subarray(srcStart, srcStart + expectedRowBytes),
							destStart,
						);
					}
				}
			}

			mirrorCtx.putImageData(mirrorImageData, 0, 0);
			return true;
		},
		dispose: () => {
			cleanup();
			if (
				ws.readyState !== WebSocket.CLOSING &&
				ws.readyState !== WebSocket.CLOSED
			) {
				ws.close();
			}
		},
	};

	function handleWorkerMessage(e: MessageEvent<WorkerMessage>) {
		if (e.data.type === "ready") {
			setIsWorkerReady(true);
			return;
		}

		if (e.data.type === "error") {
			console.error("[FrameWorker]", e.data.message);
			isProcessingSharedFrame = false;
			isProcessing = false;
			processNextFrame();
			return;
		}

		if (e.data.type === "frame-queued") {
			const { width, height } = e.data;
			onmessage({ width, height });
			isProcessingSharedFrame = false;
			isProcessing = false;
			processNextFrame();
			return;
		}

		if (e.data.type === "frame-rendered") {
			const { width, height } = e.data;
			if (!hasRenderedFrame()) {
				setHasRenderedFrame(true);
			}
			onmessage({ width, height });
			recordRender(0, "worker");
			if (isProcessingSharedFrame) {
				isProcessingSharedFrame = false;
				isProcessing = false;
				processNextFrame();
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
			isProcessingSharedFrame = false;
			isProcessing = false;
			processNextFrame();
		}
	}

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

		const frameWorker = ensureWorker();
		if (producer) {
			const written = producer.write(buffer);
			if (!written) {
				sharedBufferFallbacks++;
				isProcessingSharedFrame = false;
				frameWorker.postMessage({ type: "frame", buffer }, [buffer]);
			} else {
				sharedBufferWrites++;
				isProcessingSharedFrame = true;
				frameWorker.postMessage({ type: "wake" });
			}
		} else {
			isProcessingSharedFrame = false;
			frameWorker.postMessage({ type: "frame", buffer }, [buffer]);
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
	let actualRendersCount = 0;
	let minFrameTime = Number.MAX_VALUE;
	let maxFrameTime = 0;
	let renderTimeSum = 0;
	let renderTimeCount = 0;
	let maxRenderMs = 0;
	let uploadTimeSum = 0;
	let uploadTimeCount = 0;
	let maxUploadMs = 0;
	let receiveToDisplaySum = 0;
	let receiveToDisplayCount = 0;
	let maxReceiveToDisplayMs = 0;
	let sharedBufferWrites = 0;
	let sharedBufferFallbacks = 0;
	let statsWindowStartedAt = performance.now();
	let transportMode: FpsStats["transportMode"] = "pending";

	function recordRender(
		durationMs: number,
		mode: FpsStats["transportMode"],
		timing?: WebGPURenderTiming,
		receivedAt?: number,
	) {
		transportMode = mode;
		actualRendersCount++;
		const renderMs = timing?.totalMs ?? durationMs;
		if (renderMs > 0) {
			renderTimeSum += renderMs;
			renderTimeCount++;
			maxRenderMs = Math.max(maxRenderMs, renderMs);
		}
		if (timing) {
			uploadTimeSum += timing.uploadMs;
			uploadTimeCount++;
			maxUploadMs = Math.max(maxUploadMs, timing.uploadMs);
		}
		if (receivedAt !== undefined) {
			const receiveToDisplayMs = performance.now() - receivedAt;
			receiveToDisplaySum += receiveToDisplayMs;
			receiveToDisplayCount++;
			maxReceiveToDisplayMs = Math.max(
				maxReceiveToDisplayMs,
				receiveToDisplayMs,
			);
		}
	}

	const resetStatsWindow = (now: number) => {
		frameCount = 0;
		frameTimeSum = 0;
		totalBytesReceived = 0;
		actualRendersCount = 0;
		minFrameTime = Number.MAX_VALUE;
		maxFrameTime = 0;
		renderTimeSum = 0;
		renderTimeCount = 0;
		maxRenderMs = 0;
		uploadTimeSum = 0;
		uploadTimeCount = 0;
		maxUploadMs = 0;
		receiveToDisplaySum = 0;
		receiveToDisplayCount = 0;
		maxReceiveToDisplayMs = 0;
		sharedBufferWrites = 0;
		sharedBufferFallbacks = 0;
		statsWindowStartedAt = now;
	};

	const getLocalFpsStats = (): FpsStats => {
		const windowMs = performance.now() - statsWindowStartedAt;
		const elapsedSecs = Math.max(windowMs / 1000, 0.001);
		return {
			fps: frameCount / elapsedSecs,
			renderFps: actualRendersCount / elapsedSecs,
			avgFrameMs: frameCount > 0 ? frameTimeSum / frameCount : 0,
			minFrameMs: minFrameTime === Number.MAX_VALUE ? 0 : minFrameTime,
			maxFrameMs: maxFrameTime,
			mbPerSec: totalBytesReceived / 1_000_000 / elapsedSecs,
			avgRenderMs: renderTimeCount > 0 ? renderTimeSum / renderTimeCount : 0,
			maxRenderMs,
			avgUploadMs: uploadTimeCount > 0 ? uploadTimeSum / uploadTimeCount : 0,
			maxUploadMs,
			avgReceiveToDisplayMs:
				receiveToDisplayCount > 0
					? receiveToDisplaySum / receiveToDisplayCount
					: 0,
			maxReceiveToDisplayMs,
			sharedBufferWrites,
			sharedBufferFallbacks,
			frameCount,
			renderCount: actualRendersCount,
			uploadCount: uploadTimeCount,
			receiveToDisplayCount,
			windowMs,
			transportMode,
		};
	};

	globalFpsStatsGetter = getLocalFpsStats;
	(globalThis as Record<string, unknown>).__capFpsStats = getLocalFpsStats;

	ws.binaryType = "arraybuffer";
	ws.onmessage = (event) => {
		const buffer = event.data as ArrayBuffer;
		const now = performance.now();
		if (now - statsWindowStartedAt >= 1000) {
			resetStatsWindow(now);
		}
		totalBytesReceived += buffer.byteLength;

		const nv12Metadata = readNv12Metadata(buffer);

		if (lastFrameTime > 0) {
			const delta = now - lastFrameTime;
			frameCount++;
			frameTimeSum += delta;
			minFrameTime = Math.min(minFrameTime, delta);
			maxFrameTime = Math.max(maxFrameTime, delta);
		}
		lastFrameTime = now;

		if (nv12Metadata) {
			if (mainThreadWebGPU && directCanvas) {
				const { height, width } = nv12Metadata;

				if (width > 0 && height > 0) {
					if (directCanvas.width !== width || directCanvas.height !== height) {
						directCanvas.width = width;
						directCanvas.height = height;
					}

					schedulePendingNv12Frame(buffer, now);
				}
				return;
			}

			if (mainThreadWebGPUInitializing || !directCanvas) {
				pendingNv12Frame = { buffer, receivedAt: now };
				const { height, width } = nv12Metadata;
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

				const { yStride, height, width } = nv12Metadata;

				if (width > 0 && height > 0) {
					const ySize = yStride * height;
					const uvSize = yStride * (height / 2);
					const totalSize = ySize + uvSize;

					if (totalSize > 0) {
						schedulePendingNv12FrameCanvas2D(buffer, now);
					}
				}
				return;
			}

			if (workerCanvasMode) {
				if (isProcessing) {
					nextFrame = buffer;
				} else {
					pendingFrame = buffer;
					processNextFrame();
				}
				return;
			}

			pendingNv12Frame = { buffer, receivedAt: now };
			const { height, width } = nv12Metadata;
			if (width > 0 && height > 0) {
				onmessage({ width, height });
			}
			return;
		}

		if (mainThreadWebGPU && directCanvas && buffer.byteLength >= 24) {
			const metadataOffset = buffer.byteLength - 24;
			const meta = new DataView(buffer, metadataOffset, 24);
			const height = meta.getUint32(4, true);
			const width = meta.getUint32(8, true);

			if (width > 0 && height > 0) {
				if (directCanvas.width !== width || directCanvas.height !== height) {
					directCanvas.width = width;
					directCanvas.height = height;
				}

				schedulePendingRgbaFrame(buffer, now);
			}
			return;
		}

		if (
			mainThreadWebGPUInitializing &&
			directCanvas &&
			buffer.byteLength >= 24
		) {
			const metadataOffset = buffer.byteLength - 24;
			const meta = new DataView(buffer, metadataOffset, 24);
			const height = meta.getUint32(4, true);
			const width = meta.getUint32(8, true);

			if (width > 0 && height > 0) {
				pendingRgbaFrame = { buffer, receivedAt: now };
				onmessage({ width, height });
			}
			return;
		}

		if (directCanvas && directCtx) {
			if (buffer.byteLength >= 24) {
				const metadataOffset = buffer.byteLength - 24;
				const meta = new DataView(buffer, metadataOffset, 24);
				const height = meta.getUint32(4, true);
				const width = meta.getUint32(8, true);

				if (width > 0 && height > 0) {
					schedulePendingRgbaFrameCanvas2D(buffer, now);
				}
			}
			return;
		}

		if (workerCanvasMode) {
			if (isProcessing) {
				nextFrame = buffer;
			} else {
				pendingFrame = buffer;
				processNextFrame();
			}
			return;
		}

		if (buffer.byteLength >= 24) {
			const metadataOffset = buffer.byteLength - 24;
			const meta = new DataView(buffer, metadataOffset, 24);
			const height = meta.getUint32(4, true);
			const width = meta.getUint32(8, true);
			if (width > 0 && height > 0) {
				pendingRgbaFrame = { buffer, receivedAt: now };
				onmessage({ width, height });
			}
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
