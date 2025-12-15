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

export type { FrameRenderedMessage, DecodedFrame, ErrorMessage, ReadyMessage };

type IncomingMessage =
	| FrameMessage
	| InitCanvasMessage
	| ResizeMessage
	| InitSharedBufferMessage;

let wasmReady = false;
let pendingFrames: ArrayBuffer[] = [];

let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
let lastImageData: ImageData | null = null;
let pendingCanvasInit: OffscreenCanvas | null = null;

let cachedPixelBuffer: Uint8ClampedArray | null = null;
let cachedPixelBufferSize = 0;
let strideBuffer: Uint8ClampedArray | null = null;
let strideBufferSize = 0;
let cachedImageData: ImageData | null = null;
let cachedWidth = 0;
let cachedHeight = 0;

let consumer: Consumer | null = null;
let useSharedBuffer = false;
let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;

function decompressLz4(compressedBuffer: ArrayBuffer): Uint8Array {
	return lz4.decompress(new Uint8Array(compressedBuffer));
}

async function initWasm() {
	try {
		const testData = new Uint8Array([4, 0, 0, 0, 0x40, 0x74, 0x65, 0x73, 0x74]);
		lz4.decompress(testData);
		wasmReady = true;
		self.postMessage({ type: "ready" } satisfies ReadyMessage);

		if (pendingCanvasInit) {
			initCanvas(pendingCanvasInit);
			pendingCanvasInit = null;
		}

		for (const buffer of pendingFrames) {
			const result = await processFrame(buffer);
			if (result.type === "decoded") {
				self.postMessage(result, { transfer: [result.bitmap] });
			} else {
				self.postMessage(result);
			}
		}
		pendingFrames = [];

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
	}
}

async function processFrame(
	buffer: ArrayBuffer,
): Promise<FrameRenderedMessage | DecodedFrame | ErrorMessage> {
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

	let pixels: Uint8ClampedArray;

	if (strideBytes === expectedRowBytes) {
		if (!cachedPixelBuffer || cachedPixelBufferSize < expectedLength) {
			cachedPixelBuffer = new Uint8ClampedArray(expectedLength);
			cachedPixelBufferSize = expectedLength;
		}
		cachedPixelBuffer.set(source.subarray(0, expectedLength));
		pixels = cachedPixelBuffer.subarray(0, expectedLength);
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
		pixels = strideBuffer.subarray(0, expectedLength);
	}

	if (!cachedImageData || cachedWidth !== width || cachedHeight !== height) {
		cachedImageData = new ImageData(width, height);
		cachedWidth = width;
		cachedHeight = height;
	}
	cachedImageData.data.set(pixels);

	lastImageData = cachedImageData;

	if (offscreenCanvas && offscreenCtx) {
		if (offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
			offscreenCanvas.width = width;
			offscreenCanvas.height = height;
		}
		offscreenCtx.putImageData(cachedImageData, 0, 0);

		return {
			type: "frame-rendered",
			width,
			height,
		};
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
		} else {
			self.postMessage(result);
		}
	}

	if (!consumer.isShutdown()) {
		pollTimeoutId = setTimeout(pollSharedBuffer, 0);
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
		} else {
			self.postMessage(result);
		}
	}
};
