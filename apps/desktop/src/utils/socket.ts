import { createWS } from "@solid-primitives/websocket";
import { createResource, createSignal } from "solid-js";

export function createImageDataWS(
	url: string,
	onmessage: (data: { width: number; data: ImageData }) => void,
): [Omit<WebSocket, "onmessage">, () => boolean] {
	const [isConnected, setIsConnected] = createSignal(false);
	const ws = createWS(url);

	ws.addEventListener("open", () => {
		console.log("WebSocket connected");
		setIsConnected(true);
	});

	ws.addEventListener("close", () => {
		console.log("WebSocket disconnected");
		setIsConnected(false);
	});

	ws.addEventListener("error", (error) => {
		console.error("WebSocket error:", error);
		setIsConnected(false);
	});

	ws.binaryType = "arraybuffer";
	ws.onmessage = (event) => {
		const buffer = event.data as ArrayBuffer;
		const clamped = new Uint8ClampedArray(buffer);
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

		const imageData = new ImageData(pixels, width, height);
		onmessage({ width, data: imageData });
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
