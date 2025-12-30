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

interface RequestFrameMessage {
	type: "request-frame";
}

export type {
	FrameRenderedMessage,
	FrameQueuedMessage,
	RendererModeMessage,
	DecodedFrame,
	ErrorMessage,
	ReadyMessage,
	RequestFrameMessage,
};

type IncomingMessage =
	| FrameMessage
	| InitCanvasMessage
	| ResizeMessage
	| InitSharedBufferMessage
	| CleanupMessage;

interface FrameTiming {
	frameNumber: number;
	targetTimeNs: bigint;
}

interface PendingFrameCanvas2D {
	mode: "canvas2d";
	imageData: ImageData;
	width: number;
	height: number;
	timing: FrameTiming;
}

interface PendingFrameWebGPU {
	mode: "webgpu";
	data: Uint8ClampedArray;
	width: number;
	height: number;
	strideBytes: number;
	timing: FrameTiming;
}

type PendingFrame = PendingFrameCanvas2D | PendingFrameWebGPU;

let workerReady = false;
let isInitializing = false;
let initializationPromise: Promise<void> | null = null;

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

let lastRawFrameData: Uint8ClampedArray | null = null;
let lastRawFrameWidth = 0;
let lastRawFrameHeight = 0;

let frameDropCount = 0;
let lastFrameDropLogTime = 0;

let consumer: Consumer | null = null;
let useSharedBuffer = false;
let sharedReadBuffer: Uint8Array | null = null;
let sharedReadBufferSize = 0;

let pendingRenderFrame: PendingFrame | null = null;
let _rafId: number | null = null;
let rafRunning = false;

let playbackStartTime: number | null = null;
let playbackStartFrameNumber = 0;
let lastRenderedFrameNumber = -1;

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
		const now = performance.now();
		const frameNum = frame.timing.frameNumber;

		const isSeek =
			playbackStartTime !== null &&
			lastRenderedFrameNumber >= 0 &&
			(frameNum < lastRenderedFrameNumber ||
				frameNum > lastRenderedFrameNumber + 10);

		if (playbackStartTime === null || isSeek) {
			playbackStartTime = now;
			playbackStartFrameNumber = frameNum;
		}

		let shouldRender = true;

		if (frame.timing.targetTimeNs > 0n) {
			const elapsedMs = now - playbackStartTime;
			const startFrameTimeNs =
				(BigInt(playbackStartFrameNumber) * 1_000_000_000n) / 60n;
			const adjustedTargetNs = frame.timing.targetTimeNs - startFrameTimeNs;
			const targetMs = Number(adjustedTargetNs / 1_000_000n);
			const diffMs = targetMs - elapsedMs;

			if (diffMs > 8) {
				shouldRender = false;
			} else if (diffMs < -33) {
				if (frameNum <= lastRenderedFrameNumber && !isSeek) {
					shouldRender = false;
				}
			}
		}

		if (shouldRender) {
			pendingRenderFrame = null;
			lastRenderedFrameNumber = frameNum;

			if (frame.mode === "webgpu" && webgpuRenderer) {
				renderFrameWebGPU(
					webgpuRenderer,
					frame.data,
					frame.width,
					frame.height,
					frame.strideBytes,
				);
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
	sharedReadBuffer = null;
	sharedReadBufferSize = 0;
	pendingRenderFrame = null;
	lastImageData = null;
	cachedImageData = null;
	cachedWidth = 0;
	cachedHeight = 0;
	strideBuffer = null;
	strideBufferSize = 0;
	lastRawFrameData = null;
	lastRawFrameWidth = 0;
	lastRawFrameHeight = 0;
	frameDropCount = 0;
	lastFrameDropLogTime = 0;
	playbackStartTime = null;
	playbackStartFrameNumber = 0;
	lastRenderedFrameNumber = -1;
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

async function initCanvas(canvas: OffscreenCanvas): Promise<void> {
	if (isInitializing) {
		return initializationPromise ?? Promise.resolve();
	}
	isInitializing = true;

	const doInit = async () => {
		offscreenCanvas = canvas;

		const webgpuSupported = await isWebGPUSupported();

		if (webgpuSupported) {
			try {
				webgpuRenderer = await initWebGPU(canvas);
				renderMode = "webgpu";
				self.postMessage({
					type: "renderer-mode",
					mode: "webgpu",
				} satisfies RendererModeMessage);
			} catch (e) {
				console.error("[frame-worker] WebGPU init failed:", e);
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

		let frameRendered = false;
		if (
			renderMode === "webgpu" &&
			webgpuRenderer &&
			lastRawFrameData &&
			lastRawFrameWidth > 0 &&
			lastRawFrameHeight > 0
		) {
			renderFrameWebGPU(
				webgpuRenderer,
				lastRawFrameData,
				lastRawFrameWidth,
				lastRawFrameHeight,
				lastRawFrameWidth * 4,
			);
			self.postMessage({
				type: "frame-rendered",
				width: lastRawFrameWidth,
				height: lastRawFrameHeight,
			} satisfies FrameRenderedMessage);
			frameRendered = true;
		} else if (renderMode === "canvas2d" && lastImageData && offscreenCtx) {
			offscreenCanvas.width = lastImageData.width;
			offscreenCanvas.height = lastImageData.height;
			offscreenCtx.putImageData(lastImageData, 0, 0);
			self.postMessage({
				type: "frame-rendered",
				width: lastImageData.width,
				height: lastImageData.height,
			} satisfies FrameRenderedMessage);
			frameRendered = true;
		} else if (renderMode === "canvas2d" && offscreenCtx) {
			offscreenCtx.fillStyle = "#000000";
			offscreenCtx.fillRect(0, 0, canvas.width, canvas.height);
		}

		startRenderLoop();

		if (!frameRendered) {
			self.postMessage({ type: "request-frame" });
		}
	};

	initializationPromise = doInit().finally(() => {
		isInitializing = false;
		initializationPromise = null;
	});

	return initializationPromise;
}

type DecodeResult = FrameQueuedMessage | DecodedFrame | ErrorMessage;

async function processFrameBytes(bytes: Uint8Array): Promise<DecodeResult> {
	if (bytes.byteLength < 24) {
		return {
			type: "error",
			message: "Received frame too small to contain metadata",
		};
	}

	const metadataOffset = bytes.byteOffset + bytes.byteLength - 24;
	const meta = new DataView(bytes.buffer, metadataOffset, 24);
	const strideBytes = meta.getUint32(0, true);
	const height = meta.getUint32(4, true);
	const width = meta.getUint32(8, true);
	const frameNumber = meta.getUint32(12, true);
	const targetTimeNs = meta.getBigUint64(16, true);
	const timing: FrameTiming = { frameNumber, targetTimeNs };
	const frameData = new Uint8ClampedArray(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength - 24,
	);

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

	if (renderMode === "webgpu" && webgpuRenderer) {
		if (pendingRenderFrame !== null) {
			frameDropCount++;
			const now = performance.now();
			if (now - lastFrameDropLogTime > 1000) {
				if (frameDropCount > 0) {
					console.warn(
						`[frame-worker] Dropped ${frameDropCount} frames in the last second`,
					);
				}
				frameDropCount = 0;
				lastFrameDropLogTime = now;
			}
		}

		pendingRenderFrame = {
			mode: "webgpu",
			data: frameData.subarray(0, availableLength),
			width,
			height,
			strideBytes,
			timing,
		};
		return { type: "frame-queued", width, height };
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

	if (!lastRawFrameData || lastRawFrameData.length < expectedLength) {
		lastRawFrameData = new Uint8ClampedArray(expectedLength);
	}
	lastRawFrameData.set(processedFrameData);
	lastRawFrameWidth = width;
	lastRawFrameHeight = height;

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
			timing,
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

	if (!sharedReadBuffer || sharedReadBufferSize < consumer.getSlotSize()) {
		sharedReadBuffer = new Uint8Array(consumer.getSlotSize());
		sharedReadBufferSize = sharedReadBuffer.byteLength;
	}

	const size = consumer.readInto(sharedReadBuffer, 50);
	if (size != null && size > 0) {
		const result = await processFrameBytes(sharedReadBuffer.subarray(0, size));
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
		sharedReadBuffer = null;
		sharedReadBufferSize = 0;

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
		await initCanvas(e.data.canvas);
		return;
	}

	if (e.data.type === "resize") {
		if (offscreenCanvas) {
			offscreenCanvas.width = e.data.width;
			offscreenCanvas.height = e.data.height;
			if (offscreenCtx) {
				if (
					lastImageData &&
					lastImageData.width === e.data.width &&
					lastImageData.height === e.data.height
				) {
					offscreenCtx.putImageData(lastImageData, 0, 0);
				} else {
					lastImageData = null;
					cachedImageData = null;
					cachedWidth = 0;
					cachedHeight = 0;
					offscreenCtx.fillStyle = "#000000";
					offscreenCtx.fillRect(0, 0, e.data.width, e.data.height);
				}
			}
		}
		return;
	}

	if (e.data.type === "frame") {
		const result = await processFrameBytes(new Uint8Array(e.data.buffer));
		if (result.type === "decoded") {
			self.postMessage(result, { transfer: [result.bitmap] });
		} else if (result.type === "frame-queued") {
			self.postMessage(result);
		} else if (result.type === "error") {
			self.postMessage(result);
		}
	}
};
