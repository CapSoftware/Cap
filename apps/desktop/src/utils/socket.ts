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

		const widthArr = clamped.slice(clamped.length - 4);
		const heightArr = clamped.slice(clamped.length - 8, clamped.length - 4);
		const strideArr = clamped.slice(clamped.length - 12, clamped.length - 8);

		const width =
			widthArr[0] +
			(widthArr[1] << 8) +
			(widthArr[2] << 16) +
			(widthArr[3] << 24);
		const height =
			heightArr[0] +
			(heightArr[1] << 8) +
			(heightArr[2] << 16) +
			(heightArr[3] << 24);
		const stride =
			(strideArr[0] +
				(strideArr[1] << 8) +
				(strideArr[2] << 16) +
				(strideArr[3] << 24)) /
			4;

		const imageData = new ImageData(
			clamped.slice(0, clamped.length - 12),
			stride,
			height,
		);

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
