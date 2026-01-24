import { cx } from "cva";
import {
	type Accessor,
	createEffect,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { createLazySignal } from "~/utils/socket";

declare global {
	interface Window {
		__CAP__: {
			cameraWsPort: number;
		};
	}
}

interface WebSocketCameraPreviewProps {
	mirrored?: boolean;
	class?: string;
	containerClass?: string;
	onFrameDimensions?: (dimensions: { width: number; height: number }) => void;
}

export function WebSocketCameraPreview(props: WebSocketCameraPreviewProps) {
	const [latestFrame, setLatestFrame] = createLazySignal<{
		width: number;
		data: ImageData;
	} | null>();

	const [frameDimensions, setFrameDimensions] = createSignal<{
		width: number;
		height: number;
	} | null>(null);

	const [isConnected, setIsConnected] = createSignal(false);

	let cameraCanvasRef: HTMLCanvasElement | undefined;
	let ws: WebSocket | undefined;

	function imageDataHandler(imageData: { width: number; data: ImageData }) {
		setLatestFrame(imageData);

		const currentDimensions = frameDimensions();
		if (
			!currentDimensions ||
			currentDimensions.width !== imageData.data.width ||
			currentDimensions.height !== imageData.data.height
		) {
			const newDimensions = {
				width: imageData.data.width,
				height: imageData.data.height,
			};
			setFrameDimensions(newDimensions);
			props.onFrameDimensions?.(newDimensions);
		}

		const ctx = cameraCanvasRef?.getContext("2d");
		ctx?.putImageData(imageData.data, 0, 0);
	}

	const createSocket = () => {
		const { cameraWsPort } = window.__CAP__;
		const socket = new WebSocket(`ws://localhost:${cameraWsPort}`);
		socket.binaryType = "arraybuffer";

		socket.addEventListener("open", () => {
			setIsConnected(true);
		});

		socket.addEventListener("close", () => {
			setIsConnected(false);
		});

		socket.addEventListener("error", () => {
			setIsConnected(false);
		});

		socket.onmessage = (event) => {
			const buffer = event.data as ArrayBuffer;
			const clamped = new Uint8ClampedArray(buffer);
			if (clamped.length < 24) {
				console.error("Received frame too small to contain metadata");
				return;
			}

			const metadataOffset = clamped.length - 24;
			const meta = new DataView(buffer, metadataOffset, 24);
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

			const imageData = new ImageData(
				new Uint8ClampedArray(pixels),
				width,
				height,
			);
			imageDataHandler({ width, data: imageData });
		};

		return socket;
	};

	onMount(() => {
		ws = createSocket();

		const reconnectInterval = setInterval(() => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				if (ws) ws.close();
				ws = createSocket();
			}
		}, 5000);

		onCleanup(() => {
			clearInterval(reconnectInterval);
			ws?.close();
		});
	});

	const canvasStyle = () => {
		const frame = latestFrame();
		if (!frame) return {};

		return {
			transform: props.mirrored ? "scaleX(-1)" : "scaleX(1)",
		};
	};

	return (
		<div
			class={cx(
				"relative flex items-center justify-center overflow-hidden",
				props.containerClass,
			)}
		>
			<Show
				when={latestFrame() !== null && latestFrame() !== undefined}
				fallback={
					<div class="flex items-center justify-center text-gray-11 text-sm">
						Loading camera...
					</div>
				}
			>
				<canvas
					class={cx("max-w-full max-h-full object-contain", props.class)}
					style={canvasStyle()}
					width={latestFrame()?.data.width}
					height={latestFrame()?.data.height}
					ref={cameraCanvasRef!}
				/>
			</Show>
		</div>
	);
}

export function CameraDisconnectedOverlay() {
	return (
		<div
			class="absolute inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm px-4 pointer-events-none"
			style={{ "border-radius": "inherit" }}
		>
			<p class="text-center text-sm font-medium text-white/90">
				Camera disconnected
			</p>
		</div>
	);
}
