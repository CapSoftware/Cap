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

const SAB_SUPPORTED = isSharedArrayBufferSupported();
const FRAME_BUFFER_CONFIG: SharedFrameBufferConfig = {
	slotCount: 6,
	slotSize: 16 * 1024 * 1024,
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
	resetFrameState: () => void;
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
	let strideWorker: Worker | null = null;

	let cachedDirectImageData: ImageData | null = null;
	let cachedDirectWidth = 0;
	let cachedDirectHeight = 0;

	let cachedStrideImageData: ImageData | null = null;
	let cachedStrideWidth = 0;
	let cachedStrideHeight = 0;

	function cleanup() {
		if (isCleanedUp) return;
		isCleanedUp = true;

		if (producer) {
			producer.signalShutdown();
			producer = null;
		}

		worker.onmessage = null;
		worker.terminate();

		if (strideWorker) {
			strideWorker.onmessage = null;
			strideWorker.terminate();
			strideWorker = null;
		}

		pendingFrame = null;
		nextFrame = null;
		isProcessing = false;

		cachedDirectImageData = null;
		cachedDirectWidth = 0;
		cachedDirectHeight = 0;
		cachedStrideImageData = null;
		cachedStrideWidth = 0;
		cachedStrideHeight = 0;

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
			strideWorker = new StrideCorrectionWorker();
			strideWorker.onmessage = (e: MessageEvent<StrideCorrectionResponse>) => {
				if (e.data.type !== "corrected" || !directCanvas || !directCtx) return;

				const { buffer, width, height } = e.data;
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

				if (!hasRenderedFrame()) {
					setHasRenderedFrame(true);
				}
				onmessage({ width, height });
			};
		},
		resetFrameState: () => {
			worker.postMessage({ type: "reset-frame-state" });
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
			const { width, height } = e.data;
			onmessage({ width, height });
			actualRendersCount++;
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

	let lastFrameTime = 0;
	let frameCount = 0;
	let frameTimeSum = 0;
	let totalBytesReceived = 0;
	let lastLogTime = 0;
	let framesReceived = 0;
	let framesDropped = 0;
	let framesSentToWorker = 0;
	let actualRendersCount = 0;
	let minFrameTime = Number.MAX_VALUE;
	let maxFrameTime = 0;

	const getFpsStats = () => ({
		fps:
			frameCount > 0 && frameTimeSum > 0
				? 1000 / (frameTimeSum / frameCount)
				: 0,
		renderFps: actualRendersCount,
		avgFrameMs: frameCount > 0 ? frameTimeSum / frameCount : 0,
		minFrameMs: minFrameTime === Number.MAX_VALUE ? 0 : minFrameTime,
		maxFrameMs: maxFrameTime,
		mbPerSec: totalBytesReceived / 1_000_000,
	});

	(globalThis as Record<string, unknown>).__capFpsStats = getFpsStats;

	const NV12_MAGIC = 0x4e563132;

	ws.binaryType = "arraybuffer";
	ws.onmessage = (event) => {
		const buffer = event.data as ArrayBuffer;
		const now = performance.now();
		totalBytesReceived += buffer.byteLength;
		framesReceived++;

		let isNv12Format = false;
		if (buffer.byteLength >= 28) {
			const formatCheck = new DataView(buffer, buffer.byteLength - 4, 4);
			isNv12Format = formatCheck.getUint32(0, true) === NV12_MAGIC;
		}

		if (lastFrameTime > 0) {
			const delta = now - lastFrameTime;
			frameCount++;
			frameTimeSum += delta;
			minFrameTime = Math.min(minFrameTime, delta);
			maxFrameTime = Math.max(maxFrameTime, delta);

			if (frameCount % 60 === 0) {
				const avgDelta = frameTimeSum / 60;
				const elapsedSec = (now - lastLogTime) / 1000;
				const mbPerSec = totalBytesReceived / 1_000_000 / elapsedSec;
				const recvFps = framesReceived / elapsedSec;
				const sentFps = framesSentToWorker / elapsedSec;
				const actualFps = actualRendersCount / elapsedSec;
				const dropRate =
					framesReceived > 0 ? (framesDropped / framesReceived) * 100 : 0;

				console.log(
					`[Frame] recv: ${recvFps.toFixed(1)}/s, sent: ${sentFps.toFixed(1)}/s, ACTUAL: ${actualFps.toFixed(1)}/s, dropped: ${dropRate.toFixed(0)}%, delta: ${avgDelta.toFixed(1)}ms, ${mbPerSec.toFixed(1)} MB/s, ${isNv12Format ? "NV12" : "RGBA"}`,
				);

				frameCount = 0;
				frameTimeSum = 0;
				totalBytesReceived = 0;
				lastLogTime = now;
				framesReceived = 0;
				framesDropped = 0;
				framesSentToWorker = 0;
				actualRendersCount = 0;
				minFrameTime = Number.MAX_VALUE;
				maxFrameTime = 0;
			}
		} else {
			lastLogTime = now;
		}
		lastFrameTime = now;

		if (isNv12Format) {
			if (isProcessing) {
				framesDropped++;
				nextFrame = buffer;
			} else {
				framesSentToWorker++;
				pendingFrame = buffer;
				processNextFrame();
			}
			return;
		}

		if (directCanvas && directCtx && strideWorker) {
			if (buffer.byteLength >= 24) {
				const metadataOffset = buffer.byteLength - 24;
				const meta = new DataView(buffer, metadataOffset, 24);
				const strideBytes = meta.getUint32(0, true);
				const height = meta.getUint32(4, true);
				const width = meta.getUint32(8, true);

				if (width > 0 && height > 0) {
					const expectedRowBytes = width * 4;
					const needsStrideCorrection = strideBytes !== expectedRowBytes;

					if (lastFrameTime > 0) {
						const delta = now - lastFrameTime;
						frameCount++;
						frameTimeSum += delta;
						minFrameTime = Math.min(minFrameTime, delta);
						maxFrameTime = Math.max(maxFrameTime, delta);
						if (frameCount % 60 === 0) {
							const avgDelta = frameTimeSum / 60;
							const elapsedSec = (now - lastLogTime) / 1000;
							const mbPerSec = totalBytesReceived / 1_000_000 / elapsedSec;
							const actualRenderFps = renderFrameCount / elapsedSec;
							console.log(
								`[Frame] recv_fps: ${(1000 / avgDelta).toFixed(1)}, render_fps: ${actualRenderFps.toFixed(1)}, mb/s: ${mbPerSec.toFixed(1)}, frame_ms: ${avgDelta.toFixed(1)} (min: ${minFrameTime.toFixed(1)}, max: ${maxFrameTime.toFixed(1)}), size: ${(buffer.byteLength / 1024).toFixed(0)}KB, format: ${isNv12Format ? "NV12" : "RGBA"}`,
							);
							frameTimeSum = 0;
							totalBytesReceived = 0;
							lastLogTime = now;
							renderFrameCount = 0;
							minFrameTime = Number.MAX_VALUE;
							maxFrameTime = 0;
						}
					} else {
						lastLogTime = now;
					}
					lastFrameTime = now;

					if (!needsStrideCorrection) {
						const frameData = new Uint8ClampedArray(
							buffer,
							0,
							expectedRowBytes * height,
						);

						if (
							directCanvas.width !== width ||
							directCanvas.height !== height
						) {
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

						if (!hasRenderedFrame()) {
							setHasRenderedFrame(true);
						}
						onmessage({ width, height });
					} else {
						strideWorker.postMessage(
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
