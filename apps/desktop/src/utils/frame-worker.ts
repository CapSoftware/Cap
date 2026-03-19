import { type Consumer, createConsumer } from "./shared-frame-buffer";
import {
	disposeWebGPU,
	initWebGPU,
	isWebGPUSupported,
	renderFrameWebGPU,
	renderNv12FrameWebGPU,
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
	| CleanupMessage
	| ResetFrameStateMessage;

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

interface PendingFrameWebGPURgba {
	mode: "webgpu";
	pixelFormat: "rgba";
	data: Uint8ClampedArray;
	width: number;
	height: number;
	strideBytes: number;
	timing: FrameTiming;
	releaseCallback?: () => void;
}

interface PendingFrameWebGPUNv12 {
	mode: "webgpu";
	pixelFormat: "nv12";
	data: Uint8ClampedArray;
	width: number;
	height: number;
	yStride: number;
	timing: FrameTiming;
	releaseCallback?: () => void;
}

type PendingFrameWebGPU = PendingFrameWebGPURgba | PendingFrameWebGPUNv12;
type PendingFrame = PendingFrameCanvas2D | PendingFrameWebGPU;

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

let lastRawFrameData: Uint8ClampedArray | null = null;
let lastRawFrameWidth = 0;
let lastRawFrameHeight = 0;

let consumer: Consumer | null = null;
let useSharedBuffer = false;
let sharedReadBuffer: Uint8Array | null = null;
let sharedReadBufferSize = 0;

const FRAME_QUEUE_SIZE = 5;
let frameQueue: PendingFrame[] = [];
let _rafId: number | null = null;
let rafRunning = false;

let playbackStartTime: number | null = null;
let playbackStartTargetTimeNs: bigint | null = null;
let lastRenderedFrameNumber = -1;

function tryPollSharedBuffer(): boolean {
	if (!consumer || !useSharedBuffer) return false;

	if (renderMode !== "webgpu") {
		if (!sharedReadBuffer || sharedReadBufferSize < consumer.getSlotSize()) {
			sharedReadBuffer = new Uint8Array(consumer.getSlotSize());
			sharedReadBufferSize = sharedReadBuffer.byteLength;
		}

		const size = consumer.readInto(sharedReadBuffer, 0);
		if (size != null && size > 0) {
			queueFrameFromBytes(sharedReadBuffer.subarray(0, size));
			return true;
		}
	}
	return false;
}

interface FrameMetadataRgba {
	format: "rgba";
	width: number;
	height: number;
	strideBytes: number;
	frameNumber: number;
	targetTimeNs: bigint;
	availableLength: number;
}

interface FrameMetadataNv12 {
	format: "nv12";
	width: number;
	height: number;
	yStride: number;
	frameNumber: number;
	targetTimeNs: bigint;
	ySize: number;
	uvSize: number;
	totalSize: number;
}

type FrameMetadata = FrameMetadataRgba | FrameMetadataNv12;

const NV12_MAGIC = 0x4e563132;

function parseFrameMetadata(bytes: Uint8Array): FrameMetadata | null {
	if (bytes.byteLength < 24) return null;

	if (bytes.byteLength >= 28) {
		const formatOffset = bytes.byteOffset + bytes.byteLength - 4;
		const formatView = new DataView(bytes.buffer, formatOffset, 4);
		const formatFlag = formatView.getUint32(0, true);

		if (formatFlag === NV12_MAGIC) {
			const metadataOffset = bytes.byteOffset + bytes.byteLength - 28;
			const meta = new DataView(bytes.buffer, metadataOffset, 28);
			const yStride = meta.getUint32(0, true);
			const height = meta.getUint32(4, true);
			const width = meta.getUint32(8, true);
			const frameNumber = meta.getUint32(12, true);
			const targetTimeNs = meta.getBigUint64(16, true);

			if (!width || !height) return null;

			const ySize = yStride * height;
			const uvSize = yStride * (height / 2);
			const totalSize = ySize + uvSize;

			if (bytes.byteLength - 28 < totalSize) {
				return null;
			}

			return {
				format: "nv12",
				width,
				height,
				yStride,
				frameNumber,
				targetTimeNs,
				ySize,
				uvSize,
				totalSize,
			};
		}
	}

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
		format: "rgba",
		width,
		height,
		strideBytes,
		frameNumber,
		targetTimeNs,
		availableLength,
	};
}

let nv12ConversionBuffer: Uint8ClampedArray | null = null;
let nv12ConversionBufferSize = 0;

function convertNv12ToRgba(
	nv12Data: Uint8ClampedArray,
	width: number,
	height: number,
	yStride: number,
): Uint8ClampedArray {
	const rgbaSize = width * height * 4;
	if (!nv12ConversionBuffer || nv12ConversionBufferSize < rgbaSize) {
		nv12ConversionBuffer = new Uint8ClampedArray(rgbaSize);
		nv12ConversionBufferSize = rgbaSize;
	}
	const rgba = nv12ConversionBuffer;

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

	const isSeek =
		lastRenderedFrameNumber >= 0 &&
		(frameNumber < lastRenderedFrameNumber ||
			frameNumber > lastRenderedFrameNumber + 30);

	if (
		playbackStartTime === null ||
		playbackStartTargetTimeNs === null ||
		isSeek
	) {
		playbackStartTime = performance.now();
		playbackStartTargetTimeNs = targetTimeNs;
	}

	lastRenderedFrameNumber = frameNumber;

	if (meta.format === "nv12") {
		const frameData = new Uint8ClampedArray(
			bytes.buffer,
			bytes.byteOffset,
			meta.totalSize,
		);
		renderNv12FrameWebGPU(
			webgpuRenderer,
			frameData,
			width,
			height,
			meta.yStride,
		);
		release();
	} else {
		const frameData = new Uint8ClampedArray(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength - 24,
		).subarray(0, meta.availableLength);
		renderFrameWebGPU(
			webgpuRenderer,
			frameData,
			width,
			height,
			meta.strideBytes,
		);
		release();
	}

	self.postMessage({
		type: "frame-rendered",
		width,
		height,
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

function queueFrameFromBytes(
	bytes: Uint8Array,
	releaseCallback?: () => void,
): void {
	const meta = parseFrameMetadata(bytes);
	if (!meta) {
		releaseCallback?.();
		return;
	}

	const { width, height, frameNumber, targetTimeNs } = meta;
	const timing: FrameTiming = { frameNumber, targetTimeNs };

	if (renderMode === "webgpu" || renderMode === "pending") {
		for (const queued of frameQueue) {
			if (queued.mode === "webgpu" && queued.releaseCallback) {
				queued.releaseCallback();
			}
		}
		frameQueue = frameQueue.filter((f) => f.mode !== "webgpu");

		if (meta.format === "nv12") {
			const frameData = new Uint8ClampedArray(
				bytes.buffer,
				bytes.byteOffset,
				meta.totalSize,
			);
			frameQueue.push({
				mode: "webgpu",
				pixelFormat: "nv12",
				data: frameData,
				width,
				height,
				yStride: meta.yStride,
				timing,
				releaseCallback,
			});
		} else {
			const metadataSize = 24;
			const frameData = new Uint8ClampedArray(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength - metadataSize,
			);
			frameQueue.push({
				mode: "webgpu",
				pixelFormat: "rgba",
				data: frameData.subarray(0, meta.availableLength),
				width,
				height,
				strideBytes: meta.strideBytes,
				timing,
				releaseCallback,
			});
		}
	} else if (meta.format === "rgba") {
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

		releaseCallback?.();

		while (frameQueue.length >= FRAME_QUEUE_SIZE) {
			frameQueue.shift();
		}

		frameQueue.push({
			mode: "canvas2d",
			imageData: cachedImageData,
			width,
			height,
			timing,
		});
	}

	self.postMessage({
		type: "frame-queued",
		width,
		height,
	} satisfies FrameQueuedMessage);
}

function renderLoop() {
	_rafId = null;

	const hasRenderer =
		renderMode === "webgpu"
			? webgpuRenderer !== null
			: offscreenCanvas !== null && offscreenCtx !== null;

	if (!hasRenderer) {
		if (renderMode === "pending" && frameQueue.length > 0) {
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

		let polled = 0;
		while (polled < 4 && tryPollSharedBuffer()) {
			polled++;
		}
	}

	let frameToRender: PendingFrame | null = null;
	let frameIndex = -1;

	for (let i = 0; i < frameQueue.length; i++) {
		const frame = frameQueue[i];
		if (
			frameToRender === null ||
			frame.timing.frameNumber > frameToRender.timing.frameNumber
		) {
			frameToRender = frame;
			frameIndex = i;
		}
	}

	if (frameToRender !== null) {
		for (let i = frameQueue.length - 1; i >= 0; i--) {
			if (i !== frameIndex) {
				const oldFrame = frameQueue[i];
				if (oldFrame.mode === "webgpu" && oldFrame.releaseCallback) {
					oldFrame.releaseCallback();
				}
				frameQueue.splice(i, 1);
				if (i < frameIndex) {
					frameIndex--;
				}
			}
		}
	}

	if (frameToRender !== null && frameIndex >= 0) {
		const frame = frameToRender;

		if (frame.mode === "webgpu" && !webgpuRenderer) {
			if (renderMode === "pending") {
				_rafId = requestAnimationFrame(renderLoop);
				return;
			}
			if (renderMode === "canvas2d" && offscreenCanvas && offscreenCtx) {
				frameQueue.splice(frameIndex, 1);
				lastRenderedFrameNumber = frame.timing.frameNumber;

				if (
					offscreenCanvas.width !== frame.width ||
					offscreenCanvas.height !== frame.height
				) {
					offscreenCanvas.width = frame.width;
					offscreenCanvas.height = frame.height;
				}

				let rgbaData: Uint8ClampedArray;
				if (frame.pixelFormat === "nv12") {
					rgbaData = convertNv12ToRgba(
						frame.data,
						frame.width,
						frame.height,
						frame.yStride,
					);
				} else {
					const expectedRowBytes = frame.width * 4;
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
				} satisfies FrameRenderedMessage);

				const shouldContinue =
					frameQueue.length > 0 ||
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

		frameQueue.splice(frameIndex, 1);
		lastRenderedFrameNumber = frame.timing.frameNumber;

		if (frame.mode === "webgpu" && webgpuRenderer) {
			if (frame.pixelFormat === "nv12") {
				renderNv12FrameWebGPU(
					webgpuRenderer,
					frame.data,
					frame.width,
					frame.height,
					frame.yStride,
				);
			} else {
				renderFrameWebGPU(
					webgpuRenderer,
					frame.data,
					frame.width,
					frame.height,
					frame.strideBytes,
				);
			}
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
		} satisfies FrameRenderedMessage);
	}

	const shouldContinue =
		frameQueue.length > 0 ||
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
	for (const frame of frameQueue) {
		if (frame.mode === "webgpu" && frame.releaseCallback) {
			frame.releaseCallback();
		}
	}
	frameQueue = [];
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
	lastImageData = null;
	cachedImageData = null;
	cachedWidth = 0;
	cachedHeight = 0;
	strideBuffer = null;
	strideBufferSize = 0;
	lastRawFrameData = null;
	lastRawFrameWidth = 0;
	lastRawFrameHeight = 0;
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

function processFrameBytesSync(
	bytes: Uint8Array,
	releaseCallback?: () => void,
): DecodeResult {
	if (bytes.byteLength < 24) {
		releaseCallback?.();
		return {
			type: "error",
			message: "Received frame too small to contain metadata",
		};
	}

	const meta = parseFrameMetadata(bytes);
	if (!meta) {
		releaseCallback?.();
		return {
			type: "error",
			message: "Failed to parse frame metadata",
		};
	}

	const { width, height, frameNumber, targetTimeNs } = meta;
	const timing: FrameTiming = { frameNumber, targetTimeNs };

	if (renderMode === "webgpu" || renderMode === "pending") {
		while (frameQueue.length >= FRAME_QUEUE_SIZE) {
			const dropped = frameQueue.shift();
			if (dropped?.mode === "webgpu" && dropped.releaseCallback) {
				dropped.releaseCallback();
			}
		}

		if (meta.format === "nv12") {
			const frameData = new Uint8ClampedArray(
				bytes.buffer,
				bytes.byteOffset,
				meta.totalSize,
			);
			frameQueue.push({
				mode: "webgpu",
				pixelFormat: "nv12",
				data: frameData,
				width,
				height,
				yStride: meta.yStride,
				timing,
				releaseCallback,
			});
		} else {
			const frameData = new Uint8ClampedArray(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength - 24,
			);
			frameQueue.push({
				mode: "webgpu",
				pixelFormat: "rgba",
				data: frameData.subarray(0, meta.availableLength),
				width,
				height,
				strideBytes: meta.strideBytes,
				timing,
				releaseCallback,
			});
		}
		startRenderLoop();
		return { type: "frame-queued", width, height };
	}

	const expectedRowBytes = width * 4;
	const expectedLength = expectedRowBytes * height;
	let processedFrameData: Uint8ClampedArray;

	if (meta.format === "nv12") {
		const nv12FrameData = new Uint8ClampedArray(
			bytes.buffer,
			bytes.byteOffset,
			meta.totalSize,
		);
		processedFrameData = convertNv12ToRgba(
			nv12FrameData,
			width,
			height,
			meta.yStride,
		);
	} else {
		const frameData = new Uint8ClampedArray(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength - 24,
		);

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

	releaseCallback?.();

	while (frameQueue.length >= FRAME_QUEUE_SIZE) {
		frameQueue.shift();
	}

	frameQueue.push({
		mode: "canvas2d",
		imageData: cachedImageData,
		width,
		height,
		timing,
	});

	if (offscreenCanvas && offscreenCtx) {
		startRenderLoop();
	}

	return { type: "frame-queued", width, height };
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
		for (const frame of frameQueue) {
			if (frame.mode === "webgpu" && frame.releaseCallback) {
				frame.releaseCallback();
			}
		}
		frameQueue = [];
		return;
	}

	if (e.data.type === "init-shared-buffer") {
		consumer = createConsumer(e.data.buffer);
		useSharedBuffer = true;
		sharedReadBuffer = null;
		sharedReadBufferSize = 0;

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
		const result = processFrameBytesSync(new Uint8Array(e.data.buffer));
		if (result.type === "frame-queued") {
			self.postMessage(result);
		} else if (result.type === "error") {
			self.postMessage(result);
		}
	}
};
