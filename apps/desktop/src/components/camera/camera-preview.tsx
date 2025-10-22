import { makePersisted } from "@solid-primitives/storage";
import {
	type Accessor,
	createMemo,
	createSignal,
	type JSX,
	onCleanup,
	Show,
	Suspense,
} from "solid-js";
import { createStore, type Store } from "solid-js/store";
import { createImageDataWS } from "~/utils/socket";

export type CameraPreviewSize = "sm" | "lg";
export type CameraPreviewShape = "round" | "square" | "full";

export type CameraPreviewState = {
	size: CameraPreviewSize;
	shape: CameraPreviewShape;
	mirrored: boolean;
};

export type CameraFrame = {
	width: number;
	data: ImageData;
};

export type FrameDimensions = {
	width: number;
	height: number;
};

type CameraPreviewGeometry = {
	base: number;
	aspect: number;
	windowWidth: number;
	windowHeight: number;
	canvasWidth: number;
	canvasHeight: number;
	offsetX: number;
	offsetY: number;
};

const CAMERA_PREVIEW_BASE_SM = 230;
const CAMERA_PREVIEW_BASE_LG = 400;

export function createCameraPreviewState() {
	return makePersisted(
		createStore<CameraPreviewState>({
			size: "sm",
			shape: "round",
			mirrored: false,
		}),
		{ name: "cameraWindowState" },
	);
}

export function createCameraPreviewStream() {
	const [latestFrame, setLatestFrame] = createSignal<CameraFrame | null>(null);
	const [frameDimensions, setFrameDimensions] =
		createSignal<FrameDimensions | null>(null);
	let canvasRef: HTMLCanvasElement | undefined;

	const drawFrame = (frame: CameraFrame) => {
		const ctx = canvasRef?.getContext("2d");
		ctx?.putImageData(frame.data, 0, 0);
	};

	const handleFrame = (frame: CameraFrame) => {
		setLatestFrame(frame);

		const dims = frameDimensions();
		if (
			!dims ||
			dims.width !== frame.data.width ||
			dims.height !== frame.data.height
		) {
			setFrameDimensions({
				width: frame.data.width,
				height: frame.data.height,
			});
		}

		drawFrame(frame);
	};

	const cameraRuntime = (
		window as Window & {
			__CAP__?: { cameraWsPort?: number };
		}
	).__CAP__;
	const { cameraWsPort } = cameraRuntime ?? {};

	if (typeof cameraWsPort !== "number") {
		const setCanvasRef = (ref: HTMLCanvasElement | undefined) => {
			canvasRef = ref;
			const frame = latestFrame();
			if (ref && frame) drawFrame(frame);
		};

		return {
			latestFrame,
			frameDimensions,
			setCanvasRef,
			isConnected: () => false,
		} as const;
	}

	const url = `ws://localhost:${cameraWsPort}`;
	const [ws, isConnected] = createImageDataWS(url, handleFrame);

	const reconnectInterval = setInterval(() => {
		if (!isConnected()) {
			console.log("Attempting to reconnect...");
			ws.close();
			const [newWs] = createImageDataWS(url, handleFrame);
			Object.assign(ws, newWs);
		}
	}, 5000);

	onCleanup(() => {
		clearInterval(reconnectInterval);
		ws.close();
	});

	const setCanvasRef = (ref: HTMLCanvasElement | undefined) => {
		canvasRef = ref;
		if (!ref) return;
		const frame = latestFrame();
		if (frame) drawFrame(frame);
	};

	return {
		latestFrame,
		frameDimensions,
		setCanvasRef,
		isConnected,
	} as const;
}

function getBaseSize(size: CameraPreviewSize) {
	return size === "sm" ? CAMERA_PREVIEW_BASE_SM : CAMERA_PREVIEW_BASE_LG;
}

export function computeCameraPreviewGeometry(
	state: Store<CameraPreviewState>,
	dimensions: FrameDimensions | null,
): CameraPreviewGeometry {
	const base = getBaseSize(state.size);
	const aspect = dimensions ? dimensions.width / dimensions.height : 1;

	const windowWidth =
		state.shape === "full" ? (aspect >= 1 ? base * aspect : base) : base;
	const windowHeight =
		state.shape === "full" ? (aspect >= 1 ? base : base / aspect) : base;

	if (state.shape === "full") {
		return {
			base,
			aspect,
			windowWidth,
			windowHeight,
			canvasWidth: windowWidth,
			canvasHeight: windowHeight,
			offsetX: 0,
			offsetY: 0,
		};
	}

	const canvasWidth = aspect > 1 ? base * aspect : base;
	const canvasHeight = aspect > 1 ? base : base * aspect;

	const offsetX = aspect > 1 ? (canvasWidth - base) / 2 : 0;
	const offsetY = aspect > 1 ? 0 : (base - canvasHeight) / 2;

	return {
		base,
		aspect,
		windowWidth,
		windowHeight,
		canvasWidth,
		canvasHeight,
		offsetX,
		offsetY,
	};
}

export function CameraPreviewSurface(props: {
	state: Store<CameraPreviewState>;
	latestFrame: Accessor<CameraFrame | null>;
	frameDimensions: Accessor<FrameDimensions | null>;
	setCanvasRef: (ref: HTMLCanvasElement | undefined) => void;
}) {
	const geometry = createMemo(() =>
		computeCameraPreviewGeometry(props.state, props.frameDimensions()),
	);

	const styleForFrame = (geo: CameraPreviewGeometry): JSX.CSSProperties => {
		if (props.state.shape === "full") {
			return {
				width: `${geo.windowWidth}px`,
				height: `${geo.windowHeight}px`,
				transform: props.state.mirrored ? "scaleX(-1)" : "scaleX(1)",
			};
		}

		return {
			width: `${geo.canvasWidth}px`,
			height: `${geo.canvasHeight}px`,
			left: `-${geo.offsetX}px`,
			top: `-${geo.offsetY}px`,
			transform: props.state.mirrored ? "scaleX(-1)" : "scaleX(1)",
		};
	};

	return (
		<Suspense fallback={<CameraLoadingState />}>
			<Show when={props.latestFrame()}>
				{(frame) => (
					<canvas
						data-tauri-drag-region
						class="absolute"
						ref={props.setCanvasRef}
						style={styleForFrame(geometry())}
						width={frame().data.width}
						height={frame().data.height}
					/>
				)}
			</Show>
		</Suspense>
	);
}

export function CameraLoadingState() {
	return (
		<div class="w-full flex-1 flex items-center justify-center">
			<div class="text-gray-11">Loading camera...</div>
		</div>
	);
}
