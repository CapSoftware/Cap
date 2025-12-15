import { type Consumer, createConsumer } from "./shared-frame-buffer";
import {
	disposeWebGPU,
	initWebGPU,
	isWebGPUSupported,
	renderFrameWebGPU,
	type WebGPURenderer,
} from "./webgpu-renderer";

interface FrameMessage {
	type: "frame";
	buffer: ArrayBuffer;
}

interface InitCanvasMessage {
	type: "init-canvas";
	canvas: OffscreenCanvas;
}

interface ResizeMessage {
	type: "resize";
	width: number;
	height: number;
}

interface InitSharedBufferMessage {
	type: "init-shared-buffer";
	buffer: SharedArrayBuffer;
}

interface CleanupMessage {
	type: "cleanup";
}

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

interface RendererModeMessage {
	type: "renderer-mode";
	mode: "webgpu" | "canvas2d";
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

export type {
	FrameRenderedMessage,
	FrameQueuedMessage,
	RendererModeMessage,
	DecodedFrame,
	ErrorMessage,
	ReadyMessage,
};

type IncomingMessage =
	| FrameMessage
	| InitCanvasMessage
	| ResizeMessage
	| InitSharedBufferMessage
	| CleanupMessage;

interface PendingFrameCanvas2D {
	mode: "canvas2d";
	imageData: ImageData;
	width: number;
	height: number;
}

interface PendingFrameWebGPU {
	mode: "webgpu";
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

type PendingFrame = PendingFrameCanvas2D | PendingFrameWebGPU;

let workerReady = false;
let isInitializing = false;

type RenderMode = "webgpu" | "canvas2d";
let renderMode: RenderMode = "canvas2d";
let webgpuRenderer: WebGPURenderer | null = null;

let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
let lastImageData: ImageData | null = null;
let pendingCanvasInit: OffscreenCanvas | null = null;

let strideBuffer: Uint8ClampedArray | null = null;
let strideBufferSize = 0;
let cachedImageData: ImageData | null = null;
let cachedWidth = 0;
let cachedHeight = 0;

let consumer: Consumer | null = null;
let useSharedBuffer = false;

let pendingRenderFrame: PendingFrame | null = null;
let _rafId: number | null = null;
let rafRunning = false;

function renderLoop() {
	_rafId = null;

	const hasRenderer =
		renderMode === "webgpu"
			? webgpuRenderer !== null
			: offscreenCanvas !== null && offscreenCtx !== null;

	if (!hasRenderer) {
		rafRunning = false;
		return;
	}

	const frame = pendingRenderFrame;
	if (frame) {
		pendingRenderFrame = null;

		if (frame.mode === "webgpu" && webgpuRenderer) {
			renderFrameWebGPU(webgpuRenderer, frame.data, frame.width, frame.height);
		} else if (frame.mode === "canvas2d" && offscreenCanvas && offscreenCtx) {
			if (
				offscreenCanvas.width !== frame.width ||
				offscreenCanvas.height !== frame.height
			) {
				offscreenCanvas.width = frame.width;
				offscreenCanvas.height = frame.height;
			}
			offscreenCtx.putImageData(frame.imageData, 0, 0);
		}

		self.postMessage({
			type: "frame-rendered",
			width: frame.width,
			height: frame.height,
		} satisfies FrameRenderedMessage);
	}

	_rafId = requestAnimationFrame(renderLoop);
}

function startRenderLoop() {
	if (rafRunning) return;

	const hasRenderer =
		renderMode === "webgpu"
			? webgpuRenderer !== null
			: offscreenCanvas !== null && offscreenCtx !== null;

	if (!hasRenderer) return;

	rafRunning = true;
	_rafId = requestAnimationFrame(renderLoop);
}

function stopRenderLoop() {
	if (_rafId !== null) {
		cancelAnimationFrame(_rafId);
		_rafId = null;
	}
	rafRunning = false;
}

function cleanup() {
	stopRenderLoop();
	if (webgpuRenderer) {
		disposeWebGPU(webgpuRenderer);
		webgpuRenderer = null;
	}
	offscreenCanvas = null;
	offscreenCtx = null;
	consumer = null;
	useSharedBuffer = false;
	pendingRenderFrame = null;
	lastImageData = null;
	cachedImageData = null;
	strideBuffer = null;
}

function initWorker() {
	workerReady = true;
	self.postMessage({ type: "ready" } satisfies ReadyMessage);

	if (pendingCanvasInit) {
		initCanvas(pendingCanvasInit);
		pendingCanvasInit = null;
	}

	if (useSharedBuffer && consumer) {
		pollSharedBuffer();
	}
}

initWorker();

async function initCanvas(canvas: OffscreenCanvas) {
	if (isInitializing) return;
	isInitializing = true;

	try {
		offscreenCanvas = canvas;

		if (await isWebGPUSupported()) {
			try {
				webgpuRenderer = await initWebGPU(canvas);
				renderMode = "webgpu";
				self.postMessage({
					type: "renderer-mode",
					mode: "webgpu",
				} satisfies RendererModeMessage);
			} catch {
				renderMode = "canvas2d";
				offscreenCtx = canvas.getContext("2d", {
					alpha: false,
					desynchronized: true,
				});
				self.postMessage({
					type: "renderer-mode",
					mode: "canvas2d",
				} satisfies RendererModeMessage);
			}
		} else {
			renderMode = "canvas2d";
			offscreenCtx = canvas.getContext("2d", {
				alpha: false,
				desynchronized: true,
			});
			self.postMessage({
				type: "renderer-mode",
				mode: "canvas2d",
			} satisfies RendererModeMessage);
		}

		if (renderMode === "canvas2d" && lastImageData && offscreenCtx) {
			offscreenCanvas.width = lastImageData.width;
			offscreenCanvas.height = lastImageData.height;
			offscreenCtx.putImageData(lastImageData, 0, 0);
		} else if (renderMode === "canvas2d" && offscreenCtx) {
			offscreenCtx.fillStyle = "#000000";
			offscreenCtx.fillRect(0, 0, canvas.width, canvas.height);
		}

		startRenderLoop();
	} finally {
		isInitializing = false;
	}
}

type DecodeResult = FrameQueuedMessage | DecodedFrame | ErrorMessage;

async function processFrame(buffer: ArrayBuffer): Promise<DecodeResult> {
	const data = new Uint8Array(buffer);
	if (data.length < 12) {
		return {
			type: "error",
			message: "Received frame too small to contain metadata",
		};
	}

	const metadataOffset = data.length - 12;
	const meta = new DataView(buffer, metadataOffset, 12);
	const strideBytes = meta.getUint32(0, true);
	const height = meta.getUint32(4, true);
	const width = meta.getUint32(8, true);
	const frameData = new Uint8ClampedArray(buffer, 0, metadataOffset);

	if (!width || !height) {
		return {
			type: "error",
			message: `Received invalid frame dimensions: ${width}x${height}`,
		};
	}

	const expectedRowBytes = width * 4;
	const expectedLength = expectedRowBytes * height;
	const availableLength = strideBytes * height;

	if (
		strideBytes === 0 ||
		strideBytes < expectedRowBytes ||
		frameData.length < availableLength
	) {
		return {
			type: "error",
			message: `Received invalid frame stride: ${strideBytes}, expected: ${expectedRowBytes}`,
		};
	}

	let processedFrameData: Uint8ClampedArray;
	if (strideBytes === expectedRowBytes) {
		processedFrameData = frameData.subarray(0, expectedLength);
	} else {
		if (!strideBuffer || strideBufferSize < expectedLength) {
			strideBuffer = new Uint8ClampedArray(expectedLength);
			strideBufferSize = expectedLength;
		}
		for (let row = 0; row < height; row += 1) {
			const srcStart = row * strideBytes;
			const destStart = row * expectedRowBytes;
			strideBuffer.set(
				frameData.subarray(srcStart, srcStart + expectedRowBytes),
				destStart,
			);
		}
		processedFrameData = strideBuffer.subarray(0, expectedLength);
	}

	if (renderMode === "webgpu" && webgpuRenderer) {
		const frameDataCopy = new Uint8ClampedArray(processedFrameData);
		pendingRenderFrame = {
			mode: "webgpu",
			data: frameDataCopy,
			width,
			height,
		};
		return { type: "frame-queued", width, height };
	}

	if (!cachedImageData || cachedWidth !== width || cachedHeight !== height) {
		cachedImageData = new ImageData(width, height);
		cachedWidth = width;
		cachedHeight = height;
	}
	cachedImageData.data.set(processedFrameData);
	lastImageData = cachedImageData;

	if (offscreenCanvas && offscreenCtx) {
		pendingRenderFrame = {
			mode: "canvas2d",
			imageData: cachedImageData,
			width,
			height,
		};

		return { type: "frame-queued", width, height };
	}

	try {
		const bitmap = await createImageBitmap(cachedImageData);
		return {
			type: "decoded",
			bitmap,
			width,
			height,
		};
	} catch (e) {
		return {
			type: "error",
			message: `Failed to create ImageBitmap: ${e}`,
		};
	}
}

async function pollSharedBuffer(): Promise<void> {
	if (!consumer || !useSharedBuffer) return;

	const buffer = consumer.read(50);
	if (buffer) {
		const result = await processFrame(buffer);
		if (result.type === "decoded") {
			self.postMessage(result, { transfer: [result.bitmap] });
		} else if (result.type === "frame-queued") {
			self.postMessage(result);
		} else if (result.type === "error") {
			self.postMessage(result);
		}
	}

	if (!consumer.isShutdown()) {
		setTimeout(pollSharedBuffer, 0);
	}
}

self.onmessage = async (e: MessageEvent<IncomingMessage>) => {
	if (e.data.type === "cleanup") {
		cleanup();
		return;
	}

	if (e.data.type === "init-shared-buffer") {
		consumer = createConsumer(e.data.buffer);
		useSharedBuffer = true;

		if (workerReady) {
			pollSharedBuffer();
		}
		return;
	}

	if (e.data.type === "init-canvas") {
		if (!workerReady) {
			pendingCanvasInit = e.data.canvas;
			return;
		}
		initCanvas(e.data.canvas);
		return;
	}

	if (e.data.type === "resize") {
		if (offscreenCanvas) {
			offscreenCanvas.width = e.data.width;
			offscreenCanvas.height = e.data.height;
			if (lastImageData && offscreenCtx) {
				offscreenCtx.putImageData(lastImageData, 0, 0);
			}
		}
		return;
	}

	if (e.data.type === "frame") {
		const result = await processFrame(e.data.buffer);
		if (result.type === "decoded") {
			self.postMessage(result, { transfer: [result.bitmap] });
		} else if (result.type === "frame-queued") {
			self.postMessage(result);
		} else if (result.type === "error") {
			self.postMessage(result);
		}
	}
};
