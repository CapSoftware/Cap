import { createWS } from "@solid-primitives/websocket";
import { createResource, createSignal } from "solid-js";
import FrameWorker from "./frame-worker?worker";

export type FrameData = {
	width: number;
	height: number;
	bitmap: ImageBitmap;
};

interface ReadyMessage {
	type: "ready";
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

type WorkerMessage = ReadyMessage | DecodedFrame | ErrorMessage;

export function createImageDataWS(
	url: string,
	onmessage: (data: FrameData) => void,
): [Omit<WebSocket, "onmessage">, () => boolean, () => boolean] {
	const [isConnected, setIsConnected] = createSignal(false);
	const [isWorkerReady, setIsWorkerReady] = createSignal(false);
	const ws = createWS(url);

	const worker = new FrameWorker();
	let pendingFrame: ArrayBuffer | null = null;
	let isProcessing = false;
	let nextFrame: ArrayBuffer | null = null;

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

		const { bitmap, width, height } = e.data;
		onmessage({ width, height, bitmap });

		isProcessing = false;
		processNextFrame();
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
		worker.postMessage({ type: "frame", buffer }, [buffer]);
	}

	ws.addEventListener("open", () => {
		setIsConnected(true);
	});

	ws.addEventListener("close", () => {
		setIsConnected(false);
		worker.terminate();
	});

	ws.addEventListener("error", () => {
		setIsConnected(false);
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

	return [ws, isConnected, isWorkerReady];
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
