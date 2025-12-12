import { createWS } from "@solid-primitives/websocket";
import * as lz4 from "lz4js";
import { createResource, createSignal } from "solid-js";

interface SocketMetrics {
	framesReceived: number;
	totalParseTimeMs: number;
	totalDecompressTimeMs: number;
	totalImageDataTimeMs: number;
	maxParseTimeMs: number;
	maxDecompressTimeMs: number;
	maxImageDataTimeMs: number;
	lastLogTime: number;
}

function decompressLz4(compressedBuffer: ArrayBuffer): Uint8Array {
	const view = new DataView(compressedBuffer);
	const uncompressedSize = view.getUint32(0, true);
	const dataAfterSize = compressedBuffer.byteLength - 4;

	if (dataAfterSize === uncompressedSize) {
		return new Uint8Array(compressedBuffer.slice(4));
	}

	const compressedData = new Uint8Array(compressedBuffer, 4);
	const output = new Uint8Array(uncompressedSize);
	lz4.decompressBlock(compressedData, output, 0, compressedData.length, 0);
	return output;
}

export function createImageDataWS(
	url: string,
	onmessage: (data: { width: number; data: ImageData }) => void,
): [Omit<WebSocket, "onmessage">, () => boolean] {
	const [isConnected, setIsConnected] = createSignal(false);
	const ws = createWS(url);

	const metrics: SocketMetrics = {
		framesReceived: 0,
		totalParseTimeMs: 0,
		totalDecompressTimeMs: 0,
		totalImageDataTimeMs: 0,
		maxParseTimeMs: 0,
		maxDecompressTimeMs: 0,
		maxImageDataTimeMs: 0,
		lastLogTime: performance.now(),
	};

	ws.addEventListener("open", () => {
		console.log("WebSocket connected");
		setIsConnected(true);
		metrics.lastLogTime = performance.now();
	});

	ws.addEventListener("close", () => {
		console.log("WebSocket disconnected");
		if (metrics.framesReceived > 0) {
			const avgParseTime = metrics.totalParseTimeMs / metrics.framesReceived;
			const avgDecompressTime =
				metrics.totalDecompressTimeMs / metrics.framesReceived;
			const avgImageDataTime =
				metrics.totalImageDataTimeMs / metrics.framesReceived;
			console.log(
				`[PERF:FRONTEND_WS] session ended - frames: ${metrics.framesReceived}, avg decompress: ${avgDecompressTime.toFixed(2)}ms, avg parse: ${avgParseTime.toFixed(2)}ms, avg imageData: ${avgImageDataTime.toFixed(2)}ms, max decompress: ${metrics.maxDecompressTimeMs.toFixed(2)}ms, max parse: ${metrics.maxParseTimeMs.toFixed(2)}ms, max imageData: ${metrics.maxImageDataTimeMs.toFixed(2)}ms`,
			);
		}
		setIsConnected(false);
	});

	ws.addEventListener("error", (error) => {
		console.error("WebSocket error:", error);
		setIsConnected(false);
	});

	ws.binaryType = "arraybuffer";
	ws.onmessage = (event) => {
		const frameStart = performance.now();
		const compressedBuffer = event.data as ArrayBuffer;
		const compressedSize = compressedBuffer.byteLength;

		const decompressStart = performance.now();
		let decompressed: Uint8Array;
		try {
			decompressed = decompressLz4(compressedBuffer);
		} catch (e) {
			console.error("Failed to decompress frame:", e);
			return;
		}
		const decompressTime = performance.now() - decompressStart;

		const buffer = decompressed.buffer;
		const clamped = new Uint8ClampedArray(decompressed);
		if (clamped.length < 12) {
			console.error("Received frame too small to contain metadata");
			return;
		}

		const metadataOffset = clamped.length - 12;
		const meta = new DataView(buffer, metadataOffset, 12);
		const strideBytes = meta.getUint32(0, true);
		const height = meta.getUint32(4, true);
		const width = meta.getUint32(8, true);

		if (!width || !height) {
			console.error("Received invalid frame dimensions", { width, height });
			return;
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
			console.error("Received invalid frame stride", {
				strideBytes,
				expectedRowBytes,
				height,
				sourceLength: source.length,
			});
			return;
		}

		let pixels: Uint8ClampedArray;

		const strideConvertStart = performance.now();
		if (strideBytes === expectedRowBytes) {
			pixels = source.subarray(0, expectedLength);
		} else {
			pixels = new Uint8ClampedArray(expectedLength);
			for (let row = 0; row < height; row += 1) {
				const srcStart = row * strideBytes;
				const destStart = row * expectedRowBytes;
				pixels.set(
					source.subarray(srcStart, srcStart + expectedRowBytes),
					destStart,
				);
			}
		}
		const parseTime = performance.now() - frameStart;

		const imageDataStart = performance.now();
		const imageData = new ImageData(pixels, width, height);
		onmessage({ width, data: imageData });
		const imageDataTime = performance.now() - imageDataStart;

		metrics.framesReceived++;
		metrics.totalDecompressTimeMs += decompressTime;
		metrics.totalParseTimeMs += parseTime;
		metrics.totalImageDataTimeMs += imageDataTime;
		metrics.maxDecompressTimeMs = Math.max(
			metrics.maxDecompressTimeMs,
			decompressTime,
		);
		metrics.maxParseTimeMs = Math.max(metrics.maxParseTimeMs, parseTime);
		metrics.maxImageDataTimeMs = Math.max(
			metrics.maxImageDataTimeMs,
			imageDataTime,
		);

		const now = performance.now();
		if (now - metrics.lastLogTime >= 2000 && metrics.framesReceived > 0) {
			const avgDecompressTime =
				metrics.totalDecompressTimeMs / metrics.framesReceived;
			const avgParseTime = metrics.totalParseTimeMs / metrics.framesReceived;
			const avgImageDataTime =
				metrics.totalImageDataTimeMs / metrics.framesReceived;
			const compressionRatio = (
				(compressedSize / decompressed.length) *
				100
			).toFixed(1);
			console.log(
				`[PERF:FRONTEND_WS] periodic - frames: ${metrics.framesReceived}, compressed: ${compressedSize} bytes (${compressionRatio}%), decompressed: ${decompressed.length} bytes, avg decompress: ${avgDecompressTime.toFixed(2)}ms, avg parse: ${avgParseTime.toFixed(2)}ms, avg imageData: ${avgImageDataTime.toFixed(2)}ms, dimensions: ${width}x${height}`,
			);
			// #region agent log
			fetch(
				"http://127.0.0.1:7242/ingest/966647b7-72f6-4ab7-b76e-6b773ac020d7",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: "socket.ts:ws_metrics",
						message: "frontend WS metrics",
						data: {
							framesReceived: metrics.framesReceived,
							avgDecompressMs: avgDecompressTime.toFixed(2),
							avgParseMs: avgParseTime.toFixed(2),
							avgImageDataMs: avgImageDataTime.toFixed(2),
							maxDecompressMs: metrics.maxDecompressTimeMs.toFixed(2),
							maxParseMs: metrics.maxParseTimeMs.toFixed(2),
							compressedBytes: compressedSize,
							decompressedBytes: decompressed.length,
							compressionRatio,
							width,
							height,
						},
						timestamp: Date.now(),
						sessionId: "debug-session",
						hypothesisId: "B",
					}),
				},
			).catch(() => {});
			// #endregion
			metrics.lastLogTime = now;
		}

		if (parseTime > 10) {
			console.warn(
				`[PERF:FRONTEND_WS] high parse time: ${parseTime.toFixed(2)}ms for ${width}x${height} frame`,
			);
		}
	};

	return [ws, isConnected];
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
