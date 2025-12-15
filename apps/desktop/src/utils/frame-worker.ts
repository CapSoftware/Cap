import * as lz4 from "lz4-wasm";
import { type Consumer, createConsumer } from "./shared-frame-buffer";

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

export type {
	FrameRenderedMessage,
	FrameQueuedMessage,
	DecodedFrame,
	ErrorMessage,
	ReadyMessage,
};

type IncomingMessage =
	| FrameMessage
	| InitCanvasMessage
	| ResizeMessage
	| InitSharedBufferMessage;

interface PendingFrame {
	imageData: ImageData;
	width: number;
	height: number;
}

let wasmReady = false;
let pendingFrames: ArrayBuffer[] = [];

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

function decompressLz4(compressedBuffer: ArrayBuffer): Uint8Array {
	return lz4.decompress(new Uint8Array(compressedBuffer));
}

function renderLoop() {
	_rafId = null;

	if (!offscreenCanvas || !offscreenCtx) {
		rafRunning = false;
		return;
	}

	const frame = pendingRenderFrame;
	if (frame) {
		pendingRenderFrame = null;

		if (
			offscreenCanvas.width !== frame.width ||
			offscreenCanvas.height !== frame.height
		) {
			offscreenCanvas.width = frame.width;
			offscreenCanvas.height = frame.height;
		}

		offscreenCtx.putImageData(frame.imageData, 0, 0);

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
	if (!offscreenCanvas || !offscreenCtx) return;

	rafRunning = true;
	_rafId = requestAnimationFrame(renderLoop);
}

async function initWasm() {
	try {
		const testData = new Uint8Array([4, 0, 0, 0, 0x40, 0x74, 0x65, 0x73, 0x74]);
		lz4.decompress(testData);
		wasmReady = true;
		self.postMessage({ type: "ready" } satisfies ReadyMessage);

		for (const buffer of pendingFrames) {
			const result = await processFrame(buffer);
			if (result.type === "decoded") {
				self.postMessage(result, { transfer: [result.bitmap] });
			} else if (result.type === "frame-queued") {
				self.postMessage(result);
			} else if (result.type === "error") {
				self.postMessage(result);
			}
		}
		pendingFrames = [];

		if (pendingCanvasInit) {
			initCanvas(pendingCanvasInit);
			pendingCanvasInit = null;
		}

		if (useSharedBuffer && consumer) {
			pollSharedBuffer();
		}
	} catch (e) {
		self.postMessage({
			type: "error",
			message: `Failed to initialize WASM LZ4: ${e}`,
		} satisfies ErrorMessage);
	}
}

initWasm();

function initCanvas(canvas: OffscreenCanvas) {
	offscreenCanvas = canvas;
	offscreenCtx = canvas.getContext("2d", {
		alpha: false,
		desynchronized: true,
	});

	if (lastImageData && offscreenCtx) {
		offscreenCanvas.width = lastImageData.width;
		offscreenCanvas.height = lastImageData.height;
		offscreenCtx.putImageData(lastImageData, 0, 0);
	} else if (offscreenCtx) {
		offscreenCtx.fillStyle = "#000000";
		offscreenCtx.fillRect(0, 0, canvas.width, canvas.height);
	}

	startRenderLoop();
}

type DecodeResult = FrameQueuedMessage | DecodedFrame | ErrorMessage;

async function processFrame(buffer: ArrayBuffer): Promise<DecodeResult> {
	let decompressed: Uint8Array;
	try {
		decompressed = decompressLz4(buffer);
	} catch (e) {
		return { type: "error", message: `Failed to decompress frame: ${e}` };
	}

	const clamped = new Uint8ClampedArray(decompressed);
	if (clamped.length < 12) {
		return {
			type: "error",
			message: "Received frame too small to contain metadata",
		};
	}

	const metadataOffset = clamped.length - 12;
	const meta = new DataView(decompressed.buffer, metadataOffset, 12);
	const strideBytes = meta.getUint32(0, true);
	const height = meta.getUint32(4, true);
	const width = meta.getUint32(8, true);

	if (!width || !height) {
		return {
			type: "error",
			message: `Received invalid frame dimensions: ${width}x${height}`,
		};
	}

	const source = clamped.subarray(0, metadataOffset);
	const expectedRowBytes = width * 4;
	const expectedLength = expectedRowBytes * height;
	const availableLength = strideBytes * height;

	if (
		strideBytes === 0 ||
		strideBytes < expectedRowBytes ||
		source.length < availableLength
	) {
		return {
			type: "error",
			message: `Received invalid frame stride: ${strideBytes}, expected: ${expectedRowBytes}`,
		};
	}

	if (!cachedImageData || cachedWidth !== width || cachedHeight !== height) {
		cachedImageData = new ImageData(width, height);
		cachedWidth = width;
		cachedHeight = height;
	}

	if (strideBytes === expectedRowBytes) {
		cachedImageData.data.set(source.subarray(0, expectedLength));
	} else {
		if (!strideBuffer || strideBufferSize < expectedLength) {
			strideBuffer = new Uint8ClampedArray(expectedLength);
			strideBufferSize = expectedLength;
		}
		for (let row = 0; row < height; row += 1) {
			const srcStart = row * strideBytes;
			const destStart = row * expectedRowBytes;
			strideBuffer.set(
				source.subarray(srcStart, srcStart + expectedRowBytes),
				destStart,
			);
		}
		cachedImageData.data.set(strideBuffer.subarray(0, expectedLength));
	}

	lastImageData = cachedImageData;

	if (offscreenCanvas && offscreenCtx) {
		pendingRenderFrame = {
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
	if (e.data.type === "init-shared-buffer") {
		consumer = createConsumer(e.data.buffer);
		useSharedBuffer = true;

		if (wasmReady) {
			pollSharedBuffer();
		}
		return;
	}

	if (e.data.type === "init-canvas") {
		if (!wasmReady) {
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
		if (!wasmReady) {
			pendingFrames.push(e.data.buffer);
			return;
		}

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
