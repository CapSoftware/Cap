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
		const init = createSharedFrameBuffer(FRAME_BUFFER_CONFIG);
		producer = createProducer(init);
		worker.postMessage({
			type: "init-shared-buffer",
			buffer: init.buffer,
		});
	}

	const [hasRenderedFrame, setHasRenderedFrame] = createSignal(false);
	let isCleanedUp = false;

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
