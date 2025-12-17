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

const SAB_SUPPORTED = isSharedArrayBufferSupported();
const FRAME_BUFFER_CONFIG: SharedFrameBufferConfig = {
	slotCount: 4,
	slotSize: 8 * 1024 * 1024,
};

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

	function cleanup() {
		if (isCleanedUp) return;
		isCleanedUp = true;

		if (producer) {
			producer.signalShutdown();
			producer = null;
		}

		worker.onmessage = null;
		worker.terminate();

		pendingFrame = null;
		nextFrame = null;
		isProcessing = false;

		setIsConnected(false);
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
			directCanvas = canvas;
			directCtx = canvas.getContext("2d", { alpha: false });
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

	ws.binaryType = "arraybuffer";
	ws.onmessage = (event) => {
		const buffer = event.data as ArrayBuffer;

		if (directCanvas && directCtx) {
			const data = new Uint8Array(buffer);
			if (data.length >= 12) {
				const metadataOffset = data.length - 12;
				const meta = new DataView(buffer, metadataOffset, 12);
				const strideBytes = meta.getUint32(0, true);
				const height = meta.getUint32(4, true);
				const width = meta.getUint32(8, true);

				if (width > 0 && height > 0) {
					const expectedRowBytes = width * 4;
					let frameData: Uint8ClampedArray;

					if (strideBytes === expectedRowBytes) {
						frameData = new Uint8ClampedArray(
							buffer,
							0,
							expectedRowBytes * height,
						);
					} else {
						frameData = new Uint8ClampedArray(expectedRowBytes * height);
						for (let row = 0; row < height; row++) {
							const srcStart = row * strideBytes;
							const destStart = row * expectedRowBytes;
							frameData.set(
								new Uint8ClampedArray(buffer, srcStart, expectedRowBytes),
								destStart,
							);
						}
					}

					if (directCanvas.width !== width || directCanvas.height !== height) {
						directCanvas.width = width;
						directCanvas.height = height;
					}

					const imageData = new ImageData(frameData, width, height);
					directCtx.putImageData(imageData, 0, 0);

					if (!hasRenderedFrame()) {
						setHasRenderedFrame(true);
					}
					onmessage({ width, height });
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
