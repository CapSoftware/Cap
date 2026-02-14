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
import {
	DEFAULT_FRAME_BUFFER_CONFIG,
	computeSharedBufferConfig,
} from "./frame-transport-config";
import { decideSabWriteFailure } from "./frame-transport-retry";
import type { StrideCorrectionResponse } from "./stride-correction-worker";
import StrideCorrectionWorker from "./stride-correction-worker?worker";
import {
	disposeWebGPU,
	initWebGPU,
	isWebGPUSupported,
	renderFrameWebGPU,
	type WebGPURenderer,
} from "./webgpu-renderer";

const SAB_SUPPORTED = isSharedArrayBufferSupported();
const SAB_WRITE_RETRY_LIMIT = 2;

export type FpsStats = {
	fps: number;
	renderFps: number;
	avgFrameMs: number;
	minFrameMs: number;
	maxFrameMs: number;
	mbPerSec: number;
	sabResizes: number;
	sabFallbacks: number;
	sabOversizeFallbacks: number;
	sabRetryLimitFallbacks: number;
	sabRetriesInFlight: number;
	sabSlotSizeBytes: number;
	sabSlotCount: number;
	sabTotalBytes: number;
	sabTotalRetryAttempts: number;
	sabTotalFramesReceived: number;
	sabTotalFramesWrittenToSharedBuffer: number;
	sabTotalFramesSentToWorker: number;
	sabTotalWorkerFallbackBytes: number;
	sabTotalSupersededDrops: number;
};

let globalFpsStatsGetter: (() => FpsStats) | null = null;

export function getFpsStats(): FpsStats | null {
	if (globalFpsStatsGetter) {
		return globalFpsStatsGetter();
	}
	return null;
}

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
	captureFrame: () => Promise<Blob | null>;
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
	let sharedBufferConfig: SharedFrameBufferConfig | null = null;
	let sharedBufferResizeFailed = false;
	let sharedBufferResizeCount = 0;
	let sabFallbackCount = 0;
	let sabOversizeFallbackCount = 0;
	let sabRetryLimitFallbackCount = 0;
	let sabFallbackWindowCount = 0;
	let sabOversizeFallbackWindowCount = 0;
	let sabRetryLimitFallbackWindowCount = 0;
	let sabWriteRetryCount = 0;
	let sabRetryScheduled = false;

	function initializeSharedBuffer(config: SharedFrameBufferConfig): boolean {
		try {
			const init = createSharedFrameBuffer(config);
			const nextProducer = createProducer(init);
			producer?.signalShutdown();
			producer = nextProducer;
			sharedBufferConfig = config;
			sharedBufferResizeCount += 1;
			worker.postMessage({
				type: "init-shared-buffer",
				buffer: init.buffer,
			});
			return true;
		} catch (e) {
			console.error(
				"[socket] SharedArrayBuffer allocation failed, falling back to non-SAB mode:",
				e instanceof Error ? e.message : e,
			);
			return false;
		}
	}

	function ensureSharedBufferCapacity(requiredBytes: number) {
		if (
			!producer ||
			!sharedBufferConfig ||
			sharedBufferResizeFailed ||
			requiredBytes <= sharedBufferConfig.slotSize
		) {
			return;
		}

		const config = computeSharedBufferConfig(
			requiredBytes,
			DEFAULT_FRAME_BUFFER_CONFIG,
		);
		if (config.slotSize <= sharedBufferConfig.slotSize) {
			return;
		}

		const initialized = initializeSharedBuffer(config);
		if (!initialized) {
			sharedBufferResizeFailed = true;
		}
	}

	if (SAB_SUPPORTED) {
		if (!initializeSharedBuffer(DEFAULT_FRAME_BUFFER_CONFIG)) {
			producer = null;
			sharedBufferConfig = null;
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

	let mainThreadWebGPU: WebGPURenderer | null = null;
	let mainThreadWebGPUInitializing = false;

	let lastRenderedFrameData: {
		data: Uint8ClampedArray;
		width: number;
		height: number;
		strideBytes: number;
	} | null = null;

	function storeRenderedFrame(
		frameData: Uint8ClampedArray,
		width: number,
		height: number,
		strideBytes: number,
	) {
		lastRenderedFrameData = {
			data: frameData,
			width,
			height,
			strideBytes,
		};
		if (!hasRenderedFrame()) {
			setHasRenderedFrame(true);
		}
	}

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
		sabRetryScheduled = false;
		sabFallbackWindowCount = 0;
		sabOversizeFallbackWindowCount = 0;
		sabRetryLimitFallbackWindowCount = 0;

		if (mainThreadWebGPU) {
			disposeWebGPU(mainThreadWebGPU);
			mainThreadWebGPU = null;
		}

		cachedDirectImageData = null;
		cachedDirectWidth = 0;
		cachedDirectHeight = 0;
		cachedStrideImageData = null;
		cachedStrideWidth = 0;
		cachedStrideHeight = 0;

		lastRenderedFrameData = null;

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
			const isNewCanvas = directCanvas !== canvas;

			if (isNewCanvas && directCanvas) {
				if (mainThreadWebGPU) {
					disposeWebGPU(mainThreadWebGPU);
					mainThreadWebGPU = null;
				}
				directCtx = null;
				mainThreadWebGPUInitializing = false;
			}

			directCanvas = canvas;

			if (!mainThreadWebGPUInitializing && !mainThreadWebGPU) {
				mainThreadWebGPUInitializing = true;
				isWebGPUSupported().then((supported) => {
					if (supported && directCanvas) {
						initWebGPU(directCanvas as unknown as OffscreenCanvas)
							.then((renderer) => {
								mainThreadWebGPU = renderer;
								mainThreadWebGPUInitializing = false;
								onRequestFrame?.();
							})
							.catch((e) => {
								mainThreadWebGPUInitializing = false;
								console.error("[Socket] Main thread WebGPU init failed:", e);
								directCtx =
									directCanvas?.getContext("2d", { alpha: false }) ?? null;
								onRequestFrame?.();
							});
					} else {
						mainThreadWebGPUInitializing = false;
						directCtx =
							directCanvas?.getContext("2d", { alpha: false }) ?? null;
						onRequestFrame?.();
					}
				});
			}

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

				storeRenderedFrame(
					cachedStrideImageData.data,
					width,
					height,
					width * 4,
				);
				onmessage({ width, height });
			};
		},
		resetFrameState: () => {
			worker.postMessage({ type: "reset-frame-state" });
		},
		captureFrame: async () => {
			if (!lastRenderedFrameData) {
				return null;
			}
			const { data, width, height } = lastRenderedFrameData;
			const imageData = new ImageData(
				new Uint8ClampedArray(data),
				width,
				height,
			);
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return null;
			}
			ctx.putImageData(imageData, 0, 0);
			return new Promise<Blob | null>((resolve) => {
				canvas.toBlob((blob) => resolve(blob), "image/png");
			});
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

	function enqueueFrameBuffer(buffer: ArrayBuffer) {
		if (isProcessing) {
			if (nextFrame) {
				framesDropped++;
				totalSupersededDrops++;
			}
			nextFrame = buffer;
		} else {
			pendingFrame = buffer;
			processNextFrame();
		}
	}

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
			ensureSharedBufferCapacity(buffer.byteLength);
			const slotSize = sharedBufferConfig?.slotSize ?? 0;
			const isOversized = slotSize > 0 && buffer.byteLength > slotSize;
			const written = producer.write(buffer);
			if (!written) {
				sabFallbackCount += 1;
				sabFallbackWindowCount += 1;
				const decision = decideSabWriteFailure(
					isOversized,
					sabWriteRetryCount,
					SAB_WRITE_RETRY_LIMIT,
				);
				sabWriteRetryCount = decision.nextRetryCount;

				if (decision.action === "retry") {
					isProcessing = false;
					totalSabRetryAttempts++;
					if (nextFrame) {
						framesDropped++;
						totalSupersededDrops++;
					}
					nextFrame = buffer;
					if (!sabRetryScheduled) {
						sabRetryScheduled = true;
						requestAnimationFrame(() => {
							sabRetryScheduled = false;
							processNextFrame();
						});
					}
					return;
				}
				if (decision.action === "fallback_oversize") {
					sabOversizeFallbackCount += 1;
					sabOversizeFallbackWindowCount += 1;
				} else {
					sabRetryLimitFallbackCount += 1;
					sabRetryLimitFallbackWindowCount += 1;
				}
				framesSentToWorker++;
				totalFramesSentToWorker++;
				totalWorkerFallbackBytes += buffer.byteLength;
				worker.postMessage({ type: "frame", buffer }, [buffer]);
			} else {
				sabWriteRetryCount = 0;
				totalFramesWrittenToSharedBuffer++;
				isProcessing = false;
				if (nextFrame || pendingFrame) {
					processNextFrame();
				}
				return;
			}
		} else {
			sabWriteRetryCount = 0;
			framesSentToWorker++;
			totalFramesSentToWorker++;
			totalWorkerFallbackBytes += buffer.byteLength;
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
	let totalSabRetryAttempts = 0;
	let totalFramesReceived = 0;
	let totalFramesWrittenToSharedBuffer = 0;
	let totalFramesSentToWorker = 0;
	let totalWorkerFallbackBytes = 0;
	let totalSupersededDrops = 0;
	let lastLogTime = 0;
	let framesReceived = 0;
	let framesDropped = 0;
	let framesSentToWorker = 0;
	let actualRendersCount = 0;
	let renderFrameCount = 0;
	let minFrameTime = Number.MAX_VALUE;
	let maxFrameTime = 0;

	const getLocalFpsStats = (): FpsStats => ({
		fps:
			frameCount > 0 && frameTimeSum > 0
				? 1000 / (frameTimeSum / frameCount)
				: 0,
		renderFps: actualRendersCount,
		avgFrameMs: frameCount > 0 ? frameTimeSum / frameCount : 0,
		minFrameMs: minFrameTime === Number.MAX_VALUE ? 0 : minFrameTime,
		maxFrameMs: maxFrameTime,
		mbPerSec: totalBytesReceived / 1_000_000,
		sabResizes: sharedBufferResizeCount,
		sabFallbacks: sabFallbackCount,
		sabOversizeFallbacks: sabOversizeFallbackCount,
		sabRetryLimitFallbacks: sabRetryLimitFallbackCount,
		sabRetriesInFlight: sabWriteRetryCount,
		sabSlotSizeBytes: sharedBufferConfig?.slotSize ?? 0,
		sabSlotCount: sharedBufferConfig?.slotCount ?? 0,
		sabTotalBytes:
			(sharedBufferConfig?.slotSize ?? 0) *
			(sharedBufferConfig?.slotCount ?? 0),
		sabTotalRetryAttempts: totalSabRetryAttempts,
		sabTotalFramesReceived: totalFramesReceived,
		sabTotalFramesWrittenToSharedBuffer: totalFramesWrittenToSharedBuffer,
		sabTotalFramesSentToWorker: totalFramesSentToWorker,
		sabTotalWorkerFallbackBytes: totalWorkerFallbackBytes,
		sabTotalSupersededDrops: totalSupersededDrops,
	});

	globalFpsStatsGetter = getLocalFpsStats;
	(globalThis as Record<string, unknown>).__capFpsStats = getLocalFpsStats;

	ws.binaryType = "arraybuffer";
	ws.onmessage = (event) => {
		const buffer = event.data as ArrayBuffer;
		const now = performance.now();
		totalBytesReceived += buffer.byteLength;
		framesReceived++;
		totalFramesReceived++;

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
					`[Frame] recv: ${recvFps.toFixed(1)}/s, sent: ${sentFps.toFixed(1)}/s, ACTUAL: ${actualFps.toFixed(1)}/s, dropped: ${dropRate.toFixed(0)}%, delta: ${avgDelta.toFixed(1)}ms, ${mbPerSec.toFixed(1)} MB/s, RGBA, sab_resizes: ${sharedBufferResizeCount}, sab_fallbacks_window: ${sabFallbackWindowCount}, sab_fallbacks_total: ${sabFallbackCount}, sab_oversize_fallbacks_window: ${sabOversizeFallbackWindowCount}, sab_oversize_fallbacks_total: ${sabOversizeFallbackCount}, sab_retry_limit_fallbacks_window: ${sabRetryLimitFallbackWindowCount}, sab_retry_limit_fallbacks_total: ${sabRetryLimitFallbackCount}, sab_retries: ${sabWriteRetryCount}`,
				);

				frameCount = 0;
				frameTimeSum = 0;
				totalBytesReceived = 0;
				lastLogTime = now;
				framesReceived = 0;
				framesDropped = 0;
				framesSentToWorker = 0;
				actualRendersCount = 0;
				sabFallbackWindowCount = 0;
				sabOversizeFallbackWindowCount = 0;
				sabRetryLimitFallbackWindowCount = 0;
				sabWriteRetryCount = 0;
				minFrameTime = Number.MAX_VALUE;
				maxFrameTime = 0;
			}
		} else {
			lastLogTime = now;
		}
		lastFrameTime = now;

		const shouldRenderDirect = Boolean(
			directCanvas && (mainThreadWebGPU || (directCtx && strideWorker)),
		);
		if (!shouldRenderDirect) {
			enqueueFrameBuffer(buffer);
			return;
		}

		if (buffer.byteLength < 24) {
			return;
		}

		const metadataOffset = buffer.byteLength - 24;
		const meta = new DataView(buffer, metadataOffset, 24);
		const strideBytes = meta.getUint32(0, true);
		const height = meta.getUint32(4, true);
		const width = meta.getUint32(8, true);
		const expectedRowBytes = width * 4;
		const frameDataSize = strideBytes * height;

		if (
			width === 0 ||
			height === 0 ||
			strideBytes === 0 ||
			strideBytes < expectedRowBytes ||
			buffer.byteLength - 24 < frameDataSize
		) {
			return;
		}

		if (mainThreadWebGPU && directCanvas) {
			const frameData = new Uint8ClampedArray(buffer, 0, frameDataSize);

			if (directCanvas.width !== width || directCanvas.height !== height) {
				directCanvas.width = width;
				directCanvas.height = height;
			}

			renderFrameWebGPU(
				mainThreadWebGPU,
				frameData,
				width,
				height,
				strideBytes,
			);
			actualRendersCount++;
			renderFrameCount++;
			storeRenderedFrame(frameData, width, height, strideBytes);
			onmessage({ width, height });
			return;
		}

		if (directCanvas && directCtx && strideWorker) {
			const needsStrideCorrection = strideBytes !== expectedRowBytes;

			if (!needsStrideCorrection) {
				const frameData = new Uint8ClampedArray(
					buffer,
					0,
					expectedRowBytes * height,
				);

				if (directCanvas.width !== width || directCanvas.height !== height) {
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

				storeRenderedFrame(
					cachedDirectImageData.data,
					width,
					height,
					width * 4,
				);
				actualRendersCount++;
				renderFrameCount++;
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
			return;
		}

		enqueueFrameBuffer(buffer);
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
