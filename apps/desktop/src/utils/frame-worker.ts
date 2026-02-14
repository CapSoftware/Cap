import { type Consumer, createConsumer } from "./shared-frame-buffer";
import {
	frameNumberForwardDelta,
	isFrameNumberNewer,
	shouldDropOutOfOrderFrame,
} from "./frame-order";
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

interface ResetFrameStateMessage {
	type: "reset-frame-state";
}

interface ReadyMessage {
	type: "ready";
}

interface FrameRenderedMessage {
	type: "frame-rendered";
	width: number;
	height: number;
	source: "shared" | "worker";
}

interface RendererModeMessage {
	type: "renderer-mode";
	mode: "webgpu" | "canvas2d";
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
	RendererModeMessage,
	ErrorMessage,
	ReadyMessage,
	RequestFrameMessage,
};

type IncomingMessage =
	| FrameMessage
	| InitCanvasMessage
	| ResizeMessage
	| InitSharedBufferMessage
	| CleanupMessage
	| ResetFrameStateMessage;

interface FrameTiming {
	frameNumber: number;
	targetTimeNs: bigint;
}

type FrameSource = "shared" | "worker";

interface PendingFrameCanvas2D {
	mode: "canvas2d";
	imageData: ImageData;
	width: number;
	height: number;
	timing: FrameTiming;
	source: FrameSource;
}

interface PendingFrameWebGPURgba {
	mode: "webgpu";
	data: Uint8ClampedArray;
	width: number;
	height: number;
	strideBytes: number;
	timing: FrameTiming;
	source: FrameSource;
	releaseCallback?: () => void;
}

type PendingFrame = PendingFrameCanvas2D | PendingFrameWebGPURgba;

let workerReady = false;
let isInitializing = false;
let initializationPromise: Promise<void> | null = null;

type RenderMode = "webgpu" | "canvas2d" | "pending";
let renderMode: RenderMode = "pending";
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

let queuedFrame: PendingFrame | null = null;
let _rafId: number | null = null;
let rafRunning = false;

let playbackStartTime: number | null = null;
let playbackStartTargetTimeNs: bigint | null = null;
let lastRenderedFrameNumber = -1;
const FRAME_ORDER_SEEK_THRESHOLD = 30;

interface FrameMetadata {
	width: number;
	height: number;
	strideBytes: number;
	frameNumber: number;
	targetTimeNs: bigint;
	availableLength: number;
}

function parseFrameMetadata(bytes: Uint8Array): FrameMetadata | null {
	if (bytes.byteLength < 24) return null;

	const metadataOffset = bytes.byteOffset + bytes.byteLength - 24;
	const meta = new DataView(bytes.buffer, metadataOffset, 24);
	const strideBytes = meta.getUint32(0, true);
	const height = meta.getUint32(4, true);
	const width = meta.getUint32(8, true);
	const frameNumber = meta.getUint32(12, true);
	const targetTimeNs = meta.getBigUint64(16, true);

	if (!width || !height) return null;

	const expectedRowBytes = width * 4;
	const availableLength = strideBytes * height;

	if (
		strideBytes === 0 ||
		strideBytes < expectedRowBytes ||
		bytes.byteLength - 24 < availableLength
	) {
		return null;
	}

	return {
		width,
		height,
		strideBytes,
		frameNumber,
		targetTimeNs,
		availableLength,
	};
}

function renderBorrowedWebGPU(bytes: Uint8Array, release: () => void): boolean {
	if (
		(renderMode !== "webgpu" && renderMode !== "pending") ||
		!webgpuRenderer
	) {
		release();
		return false;
	}

	const meta = parseFrameMetadata(bytes);
	if (!meta) {
		release();
		return false;
	}

	const { width, height, frameNumber, targetTimeNs } = meta;

	if (
		lastRenderedFrameNumber >= 0 &&
		shouldDropOutOfOrderFrame(
			frameNumber,
			lastRenderedFrameNumber,
			FRAME_ORDER_SEEK_THRESHOLD,
		)
	) {
		release();
		return false;
	}

	const isSeek =
		lastRenderedFrameNumber >= 0 &&
		(!isFrameNumberNewer(frameNumber, lastRenderedFrameNumber) ||
			frameNumberForwardDelta(frameNumber, lastRenderedFrameNumber) >
				FRAME_ORDER_SEEK_THRESHOLD);

	if (
		playbackStartTime === null ||
		playbackStartTargetTimeNs === null ||
		isSeek
	) {
		playbackStartTime = performance.now();
		playbackStartTargetTimeNs = targetTimeNs;
	}

	lastRenderedFrameNumber = frameNumber;

	const frameData = new Uint8ClampedArray(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength - 24,
	).subarray(0, meta.availableLength);
	renderFrameWebGPU(webgpuRenderer, frameData, width, height, meta.strideBytes);
	release();

	self.postMessage({
		type: "frame-rendered",
		width,
		height,
		source: "shared",
	} satisfies FrameRenderedMessage);

	return true;
}

function drainAndRenderLatestSharedWebGPU(maxDrain: number): boolean {
	if (!consumer || !useSharedBuffer || consumer.isShutdown()) return false;
	if (renderMode !== "webgpu" || !webgpuRenderer) return false;

	let latest: { bytes: Uint8Array; release: () => void } | null = null;
	let drained = 0;

	for (let i = 0; i < maxDrain; i += 1) {
		const borrowed = consumer.borrow(0);
		if (!borrowed) break;

		if (latest) {
			latest.release();
		}
		latest = { bytes: borrowed.data, release: borrowed.release };
		drained += 1;
	}

	if (!latest) return false;

	return renderBorrowedWebGPU(latest.bytes, latest.release);
}

function drainAndQueueLatestSharedFrame(maxDrain: number): boolean {
	if (!consumer || !useSharedBuffer || consumer.isShutdown()) return false;
	if (renderMode === "webgpu") return false;

	let latest: { bytes: Uint8Array; release: () => void } | null = null;

	for (let i = 0; i < maxDrain; i += 1) {
		const borrowed = consumer.borrow(0);
		if (!borrowed) break;

		if (latest) {
			latest.release();
		}
		latest = { bytes: borrowed.data, release: borrowed.release };
	}

	if (!latest) return false;

	queueFrameFromBytes(latest.bytes, latest.release, "shared");
	return true;
}

function clearQueuedFrames() {
	if (queuedFrame?.mode === "webgpu" && queuedFrame.releaseCallback) {
		queuedFrame.releaseCallback();
	}
	queuedFrame = null;
}

function queueFrameFromBytes(
	bytes: Uint8Array,
	releaseCallback?: () => void,
	source: FrameSource = "worker",
): boolean {
	const meta = parseFrameMetadata(bytes);
	if (!meta) {
		releaseCallback?.();
		return false;
	}

	const { width, height, frameNumber, targetTimeNs } = meta;
	const timing: FrameTiming = { frameNumber, targetTimeNs };
	const referenceFrameNumber =
		queuedFrame?.timing.frameNumber ??
		(lastRenderedFrameNumber >= 0 ? lastRenderedFrameNumber : null);

	if (
		referenceFrameNumber !== null &&
		shouldDropOutOfOrderFrame(
			frameNumber,
			referenceFrameNumber,
			FRAME_ORDER_SEEK_THRESHOLD,
		)
	) {
		releaseCallback?.();
		return false;
	}

	if (renderMode === "webgpu" || renderMode === "pending") {
		clearQueuedFrames();

		const metadataSize = 24;
		const frameData = new Uint8ClampedArray(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength - metadataSize,
		);
		queuedFrame = {
			mode: "webgpu",
			data: frameData.subarray(0, meta.availableLength),
			width,
			height,
			strideBytes: meta.strideBytes,
			timing,
			source,
			releaseCallback,
		};
	} else {
		const expectedRowBytes = width * 4;
		const metadataSize = 24;
		const frameData = new Uint8ClampedArray(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength - metadataSize,
		);
		const expectedLength = expectedRowBytes * height;
		let processedFrameData: Uint8ClampedArray;

		if (meta.strideBytes === expectedRowBytes) {
			processedFrameData = frameData.subarray(0, expectedLength);
		} else {
			if (!strideBuffer || strideBufferSize < expectedLength) {
				strideBuffer = new Uint8ClampedArray(expectedLength);
				strideBufferSize = expectedLength;
			}
			for (let row = 0; row < height; row += 1) {
				const srcStart = row * meta.strideBytes;
				const destStart = row * expectedRowBytes;
				strideBuffer.set(
					frameData.subarray(srcStart, srcStart + expectedRowBytes),
					destStart,
				);
			}
			processedFrameData = strideBuffer.subarray(0, expectedLength);
		}

		if (!cachedImageData || cachedWidth !== width || cachedHeight !== height) {
			cachedImageData = new ImageData(width, height);
			cachedWidth = width;
			cachedHeight = height;
		}
		cachedImageData.data.set(processedFrameData);
		lastImageData = cachedImageData;

		releaseCallback?.();
		clearQueuedFrames();

		queuedFrame = {
			mode: "canvas2d",
			imageData: cachedImageData,
			width,
			height,
			timing,
			source,
		};
	}

	startRenderLoop();
	return true;
}

function renderLoop() {
	_rafId = null;

	const hasRenderer =
		renderMode === "webgpu"
			? webgpuRenderer !== null
			: offscreenCanvas !== null && offscreenCtx !== null;

	if (!hasRenderer) {
		if (renderMode === "pending" && queuedFrame !== null) {
			_rafId = requestAnimationFrame(renderLoop);
			return;
		}
		rafRunning = false;
		return;
	}

	if (useSharedBuffer && consumer && !consumer.isShutdown()) {
		if (renderMode === "webgpu" && webgpuRenderer) {
			const rendered = drainAndRenderLatestSharedWebGPU(8);
			if (rendered) {
				_rafId = requestAnimationFrame(renderLoop);
				return;
			}
		}

		if (renderMode === "canvas2d") {
			drainAndQueueLatestSharedFrame(4);
		} else if (renderMode === "pending") {
			drainAndQueueLatestSharedFrame(4);
		}
	}

	const frame = queuedFrame;

	if (frame) {
		if (frame.mode === "webgpu" && !webgpuRenderer) {
			if (renderMode === "pending") {
				_rafId = requestAnimationFrame(renderLoop);
				return;
			}
			if (renderMode === "canvas2d" && offscreenCanvas && offscreenCtx) {
				queuedFrame = null;
				lastRenderedFrameNumber = frame.timing.frameNumber;

				if (
					offscreenCanvas.width !== frame.width ||
					offscreenCanvas.height !== frame.height
				) {
					offscreenCanvas.width = frame.width;
					offscreenCanvas.height = frame.height;
				}

				const expectedRowBytes = frame.width * 4;
				let rgbaData: Uint8ClampedArray;
				if (frame.strideBytes === expectedRowBytes) {
					rgbaData = frame.data;
				} else {
					const expectedLength = expectedRowBytes * frame.height;
					if (!strideBuffer || strideBufferSize < expectedLength) {
						strideBuffer = new Uint8ClampedArray(expectedLength);
						strideBufferSize = expectedLength;
					}
					for (let row = 0; row < frame.height; row += 1) {
						const srcStart = row * frame.strideBytes;
						const destStart = row * expectedRowBytes;
						strideBuffer.set(
							frame.data.subarray(srcStart, srcStart + expectedRowBytes),
							destStart,
						);
					}
					rgbaData = strideBuffer.subarray(0, expectedLength);
				}

				if (
					!cachedImageData ||
					cachedWidth !== frame.width ||
					cachedHeight !== frame.height
				) {
					cachedImageData = new ImageData(frame.width, frame.height);
					cachedWidth = frame.width;
					cachedHeight = frame.height;
				}
				cachedImageData.data.set(rgbaData);
				offscreenCtx.putImageData(cachedImageData, 0, 0);

				if (frame.releaseCallback) {
					frame.releaseCallback();
				}

				self.postMessage({
					type: "frame-rendered",
					width: frame.width,
					height: frame.height,
					source: frame.source,
				} satisfies FrameRenderedMessage);

				const shouldContinue =
					queuedFrame !== null ||
					(useSharedBuffer && consumer && !consumer.isShutdown());

				if (shouldContinue) {
					_rafId = requestAnimationFrame(renderLoop);
				} else {
					rafRunning = false;
				}
				return;
			}
			_rafId = requestAnimationFrame(renderLoop);
			return;
		}

		queuedFrame = null;
		lastRenderedFrameNumber = frame.timing.frameNumber;

		if (frame.mode === "webgpu" && webgpuRenderer) {
			renderFrameWebGPU(
				webgpuRenderer,
				frame.data,
				frame.width,
				frame.height,
				frame.strideBytes,
			);
			if (frame.releaseCallback) {
				frame.releaseCallback();
			}
		} else if (frame.mode === "canvas2d" && offscreenCanvas && offscreenCtx) {
			if (
				offscreenCanvas.width !== frame.width ||
				offscreenCanvas.height !== frame.height
			) {
				offscreenCanvas.width = frame.width;
				offscreenCanvas.height = frame.height;
			}
			if (frame.imageData) {
				offscreenCtx.putImageData(frame.imageData, 0, 0);
			}
		}

		self.postMessage({
			type: "frame-rendered",
			width: frame.width,
			height: frame.height,
			source: frame.source,
		} satisfies FrameRenderedMessage);
	}

	const shouldContinue =
		queuedFrame !== null ||
		(useSharedBuffer && consumer && !consumer.isShutdown());

	if (shouldContinue) {
		_rafId = requestAnimationFrame(renderLoop);
	} else {
		rafRunning = false;
	}
}

function startRenderLoop() {
	if (rafRunning) return;

	if (renderMode === "pending") {
		rafRunning = true;
		_rafId = requestAnimationFrame(renderLoop);
		return;
	}

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
	clearQueuedFrames();
	if (webgpuRenderer) {
		disposeWebGPU(webgpuRenderer);
		webgpuRenderer = null;
	}
	offscreenCanvas = null;
	offscreenCtx = null;
	consumer = null;
	useSharedBuffer = false;
	lastImageData = null;
	cachedImageData = null;
	cachedWidth = 0;
	cachedHeight = 0;
	strideBuffer = null;
	strideBufferSize = 0;
	playbackStartTime = null;
	playbackStartTargetTimeNs = null;
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
		startRenderLoop();
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
			lastImageData &&
			lastImageData.width > 0 &&
			lastImageData.height > 0
		) {
			renderFrameWebGPU(
				webgpuRenderer,
				lastImageData.data,
				lastImageData.width,
				lastImageData.height,
				lastImageData.width * 4,
			);
			self.postMessage({
				type: "frame-rendered",
				width: lastImageData.width,
				height: lastImageData.height,
				source: "worker",
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
				source: "worker",
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

self.onmessage = async (e: MessageEvent<IncomingMessage>) => {
	if (e.data.type === "cleanup") {
		cleanup();
		return;
	}

	if (e.data.type === "reset-frame-state") {
		lastRenderedFrameNumber = -1;
		playbackStartTime = null;
		playbackStartTargetTimeNs = null;
		clearQueuedFrames();
		return;
	}

	if (e.data.type === "init-shared-buffer") {
		consumer = createConsumer(e.data.buffer);
		useSharedBuffer = true;

		if (workerReady) {
			startRenderLoop();
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
		const queued = queueFrameFromBytes(
			new Uint8Array(e.data.buffer),
			undefined,
			"worker",
		);
		if (!queued) {
			const result: ErrorMessage = {
				type: "error",
				message: "Failed to parse frame metadata",
			};
			self.postMessage(result);
		}
	}
};
