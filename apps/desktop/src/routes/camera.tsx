import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { makePersisted } from "@solid-primitives/storage";
import {
	currentMonitor,
	getCurrentWindow,
	LogicalPosition,
	LogicalSize,
} from "@tauri-apps/api/window";
import { type } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	type Accessor,
	type ComponentProps,
	createEffect,
	createResource,
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCameraMutation } from "~/utils/queries";
import { createLazySignal } from "~/utils/socket";
import { commands, events } from "~/utils/tauri";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "./(window-chrome)/OptionsContext";

type CameraWindowShape = "round" | "square" | "full";
type CameraWindowState = {
	size: number;
	shape: CameraWindowShape;
	mirrored: boolean;
};

const CAMERA_MIN_SIZE = 150;
const CAMERA_MAX_SIZE = 600;
const CAMERA_DEFAULT_SIZE = 230;
const CAMERA_PRESET_SMALL = 230;
const CAMERA_PRESET_LARGE = 400;

export default function () {
	document.documentElement.classList.toggle("dark", true);

	const generalSettings = generalSettingsStore.createQuery();
	const isNativePreviewEnabled =
		(type() !== "windows" && generalSettings.data?.enableNativeCameraPreview) ||
		false;

	const [cameraDisconnected, setCameraDisconnected] = createSignal(false);

	createTauriEventListener(events.recordingEvent, (payload) => {
		if (payload.variant === "InputLost" && payload.input === "camera") {
			setCameraDisconnected(true);
		} else if (
			payload.variant === "InputRestored" &&
			payload.input === "camera"
		) {
			setCameraDisconnected(false);
		}
	});

	return (
		<RecordingOptionsProvider>
			<Show
				when={isNativePreviewEnabled}
				fallback={<LegacyCameraPreviewPage disconnected={cameraDisconnected} />}
			>
				<NativeCameraPreviewPage disconnected={cameraDisconnected} />
			</Show>
		</RecordingOptionsProvider>
	);
}

function NativeCameraPreviewPage(props: { disconnected: Accessor<boolean> }) {
	const [state, setState] = makePersisted(
		createStore<CameraWindowState>({
			size: CAMERA_DEFAULT_SIZE,
			shape: "round",
			mirrored: false,
		}),
		{ name: "cameraWindowState" },
	);

	const [isResizing, setIsResizing] = createSignal(false);
	const [resizeStart, setResizeStart] = createSignal({
		size: 0,
		x: 0,
		y: 0,
		corner: "",
	});

	createEffect(() => {
		// Support for legacy size strings.
		let currentSize = state.size as number | string;
		if (typeof currentSize !== "number" || Number.isNaN(currentSize)) {
			currentSize =
				currentSize === "lg" ? CAMERA_PRESET_LARGE : CAMERA_DEFAULT_SIZE;
			setState("size", currentSize);
			return;
		}

		const clampedSize = Math.max(
			CAMERA_MIN_SIZE,
			Math.min(CAMERA_MAX_SIZE, currentSize),
		);
		if (clampedSize !== currentSize) {
			setState("size", clampedSize);
		}
		commands.setCameraPreviewState(state);
	});

	const [cameraPreviewReady] = createResource(() =>
		commands.awaitCameraPreviewReady(),
	);

	const setCamera = createCameraMutation();

	const scale = () => {
		const normalized =
			(state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
		return 0.7 + normalized * 0.3;
	};

	const handleResizeStart = (corner: string) => (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsResizing(true);
		setResizeStart({ size: state.size, x: e.clientX, y: e.clientY, corner });
	};

	const handleResizeMove = (e: MouseEvent) => {
		if (!isResizing()) return;
		const start = resizeStart();
		const deltaX = e.clientX - start.x;
		const deltaY = e.clientY - start.y;

		let delta = 0;
		if (start.corner.includes("e") && start.corner.includes("s")) {
			delta = Math.max(deltaX, deltaY);
		} else if (start.corner.includes("e") && start.corner.includes("n")) {
			delta = Math.max(deltaX, -deltaY);
		} else if (start.corner.includes("w") && start.corner.includes("s")) {
			delta = Math.max(-deltaX, deltaY);
		} else if (start.corner.includes("w") && start.corner.includes("n")) {
			delta = Math.max(-deltaX, -deltaY);
		} else if (start.corner.includes("e")) {
			delta = deltaX;
		} else if (start.corner.includes("w")) {
			delta = -deltaX;
		} else if (start.corner.includes("s")) {
			delta = deltaY;
		} else if (start.corner.includes("n")) {
			delta = -deltaY;
		}

		const newSize = Math.max(
			CAMERA_MIN_SIZE,
			Math.min(CAMERA_MAX_SIZE, start.size + delta),
		);
		setState("size", newSize);
	};

	const handleResizeEnd = () => {
		setIsResizing(false);
	};

	createEffect(() => {
		if (isResizing()) {
			window.addEventListener("mousemove", handleResizeMove);
			window.addEventListener("mouseup", handleResizeEnd);
			onCleanup(() => {
				window.removeEventListener("mousemove", handleResizeMove);
				window.removeEventListener("mouseup", handleResizeEnd);
			});
		}
	});

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-col w-screen h-screen cursor-move group"
		>
			<Show when={props.disconnected()}>
				<CameraDisconnectedOverlay />
			</Show>
			<div class="h-13">
				<div class="flex flex-row justify-center items-center">
					<div
						class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10"
						style={{ transform: `scale(${scale()})` }}
					>
						<ControlButton onClick={() => getCurrentWindow().close()}>
							<IconCapCircleX class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.size >= CAMERA_PRESET_LARGE}
							onClick={() => {
								setState(
									"size",
									state.size < CAMERA_PRESET_LARGE
										? CAMERA_PRESET_LARGE
										: CAMERA_PRESET_SMALL,
								);
							}}
						>
							<IconCapEnlarge class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.shape !== "round"}
							onClick={() =>
								setState("shape", (s) =>
									s === "round" ? "square" : s === "square" ? "full" : "round",
								)
							}
						>
							{state.shape === "round" && <IconCapCircle class="size-5.5" />}
							{state.shape === "square" && <IconCapSquare class="size-5.5" />}
							{state.shape === "full" && (
								<IconLucideRectangleHorizontal class="size-5.5" />
							)}
						</ControlButton>
						<ControlButton
							pressed={state.mirrored}
							onClick={() => setState("mirrored", (m) => !m)}
						>
							<IconCapArrows class="size-5.5" />
						</ControlButton>
					</div>
				</div>
			</div>

			<div
				class="absolute top-0 left-0 w-4 h-4 cursor-nw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("nw")}
			/>
			<div
				class="absolute top-0 right-0 w-4 h-4 cursor-ne-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("ne")}
			/>
			<div
				class="absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("sw")}
			/>
			<div
				class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("se")}
			/>

			{/* The camera preview is rendered in Rust by wgpu */}
			<Show when={cameraPreviewReady.loading}>
				<div class="w-full flex-1 flex items-center justify-center">
					<div class="text-gray-11">Loading camera...</div>
				</div>
			</Show>
		</div>
	);
}

function ControlButton(
	props: Omit<ComponentProps<typeof KToggleButton>, "type" | "class"> & {
		active?: boolean;
	},
) {
	return (
		<KToggleButton
			type="button"
			class="p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12"
			{...props}
		/>
	);
}

// Legacy stuff below

function LegacyCameraPreviewPage(props: { disconnected: Accessor<boolean> }) {
	const { rawOptions } = useRecordingOptions();

	const [state, setState] = makePersisted(
		createStore<CameraWindowState>({
			size: CAMERA_DEFAULT_SIZE,
			shape: "round",
			mirrored: false,
		}),
		{ name: "cameraWindowState" },
	);

	createEffect(() => {
		// Support for legacy size strings.
		const currentSize = state.size as number | string;
		if (typeof currentSize !== "number" || Number.isNaN(currentSize)) {
			setState(
				"size",
				currentSize === "lg" ? CAMERA_PRESET_LARGE : CAMERA_DEFAULT_SIZE,
			);
		}
	});

	const [isResizing, setIsResizing] = createSignal(false);
	const [resizeStart, setResizeStart] = createSignal({
		size: 0,
		x: 0,
		y: 0,
		corner: "",
	});

	const [hasPositioned, setHasPositioned] = createSignal(false);

	const [latestFrame, setLatestFrame] = createLazySignal<{
		width: number;
		data: ImageData;
	} | null>();

	const [frameDimensions, setFrameDimensions] = createSignal<{
		width: number;
		height: number;
	} | null>(null);

	function imageDataHandler(imageData: { width: number; data: ImageData }) {
		setLatestFrame(imageData);

		const currentDimensions = frameDimensions();
		if (
			!currentDimensions ||
			currentDimensions.width !== imageData.data.width ||
			currentDimensions.height !== imageData.data.height
		) {
			setFrameDimensions({
				width: imageData.data.width,
				height: imageData.data.height,
			});
		}

		const ctx = cameraCanvasRef?.getContext("2d");
		ctx?.putImageData(imageData.data, 0, 0);
	}

	const { cameraWsPort } = window.__CAP__;
	const [isConnected, setIsConnected] = createSignal(false);
	let ws: WebSocket | undefined;

	const createSocket = () => {
		const socket = new WebSocket(`ws://localhost:${cameraWsPort}`);
		socket.binaryType = "arraybuffer";

		socket.addEventListener("open", () => {
			console.log("WebSocket connected");
			setIsConnected(true);
		});

		socket.addEventListener("close", () => {
			console.log("WebSocket disconnected");
			setIsConnected(false);
		});

		socket.addEventListener("error", (error) => {
			console.error("WebSocket error:", error);
			setIsConnected(false);
		});

		socket.onmessage = (event) => {
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

			const imageData = new ImageData(
				new Uint8ClampedArray(pixels),
				width,
				height,
			);
			imageDataHandler({ width, data: imageData });
		};

		return socket;
	};

	ws = createSocket();

	const reconnectInterval = setInterval(() => {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			console.log("Attempting to reconnect...");
			if (ws) ws.close();
			ws = createSocket();
		}
	}, 5000);

	onCleanup(() => {
		clearInterval(reconnectInterval);
		ws?.close();
	});

	const scale = () => {
		const normalized =
			(state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
		return 0.7 + normalized * 0.3;
	};

	const handleResizeStart = (corner: string) => (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsResizing(true);
		setResizeStart({ size: state.size, x: e.clientX, y: e.clientY, corner });
	};

	const handleResizeMove = (e: MouseEvent) => {
		if (!isResizing()) return;
		const start = resizeStart();
		const deltaX = e.clientX - start.x;
		const deltaY = e.clientY - start.y;

		let delta = 0;
		if (start.corner.includes("e") && start.corner.includes("s")) {
			delta = Math.max(deltaX, deltaY);
		} else if (start.corner.includes("e") && start.corner.includes("n")) {
			delta = Math.max(deltaX, -deltaY);
		} else if (start.corner.includes("w") && start.corner.includes("s")) {
			delta = Math.max(-deltaX, deltaY);
		} else if (start.corner.includes("w") && start.corner.includes("n")) {
			delta = Math.max(-deltaX, -deltaY);
		} else if (start.corner.includes("e")) {
			delta = deltaX;
		} else if (start.corner.includes("w")) {
			delta = -deltaX;
		} else if (start.corner.includes("s")) {
			delta = deltaY;
		} else if (start.corner.includes("n")) {
			delta = -deltaY;
		}

		const newSize = Math.max(
			CAMERA_MIN_SIZE,
			Math.min(CAMERA_MAX_SIZE, start.size + delta),
		);
		setState("size", newSize);
	};

	const handleResizeEnd = () => {
		setIsResizing(false);
	};

	createEffect(() => {
		if (isResizing()) {
			window.addEventListener("mousemove", handleResizeMove);
			window.addEventListener("mouseup", handleResizeEnd);
			onCleanup(() => {
				window.removeEventListener("mousemove", handleResizeMove);
				window.removeEventListener("mouseup", handleResizeEnd);
			});
		}
	});

	const [windowSize] = createResource(
		() =>
			[
				state.size,
				state.shape,
				frameDimensions()?.width,
				frameDimensions()?.height,
			] as const,
		async ([size, shape, frameWidth, frameHeight]) => {
			const monitor = await currentMonitor();

			const BAR_HEIGHT = 56;
			const base = Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, size));
			const aspect = frameWidth && frameHeight ? frameWidth / frameHeight : 1;
			const windowWidth =
				shape === "full" ? (aspect >= 1 ? base * aspect : base) : base;
			const windowHeight =
				shape === "full" ? (aspect >= 1 ? base : base / aspect) : base;
			const totalHeight = windowHeight + BAR_HEIGHT;

			if (!monitor) return;

			const scalingFactor = monitor.scaleFactor;
			const width = monitor.size.width / scalingFactor - windowWidth - 100;
			const height = monitor.size.height / scalingFactor - totalHeight - 100;

			const currentWindow = getCurrentWindow();

			if (!hasPositioned()) {
				currentWindow.setPosition(
					new LogicalPosition(
						width + monitor.position.toLogical(scalingFactor).x,
						height + monitor.position.toLogical(scalingFactor).y,
					),
				);
				setHasPositioned(true);
			} else {
				const outerPos = await currentWindow.outerPosition();
				const logicalPos = outerPos.toLogical(scalingFactor);
				const monitorLogicalPos = monitor.position.toLogical(scalingFactor);
				const monitorLogicalSize = monitor.size.toLogical(scalingFactor);

				let newX = logicalPos.x;
				let newY = logicalPos.y;

				// Right edge
				if (
					newX + windowWidth >
					monitorLogicalPos.x + monitorLogicalSize.width
				) {
					newX = monitorLogicalPos.x + monitorLogicalSize.width - windowWidth;
				}
				// Bottom edge
				if (
					newY + totalHeight >
					monitorLogicalPos.y + monitorLogicalSize.height
				) {
					newY = monitorLogicalPos.y + monitorLogicalSize.height - totalHeight;
				}
				// Left edge
				if (newX < monitorLogicalPos.x) {
					newX = monitorLogicalPos.x;
				}
				// Top edge
				if (newY < monitorLogicalPos.y) {
					newY = monitorLogicalPos.y;
				}

				if (
					Math.abs(newX - logicalPos.x) > 1 ||
					Math.abs(newY - logicalPos.y) > 1
				) {
					await currentWindow.setPosition(new LogicalPosition(newX, newY));
				}
			}

			await currentWindow.setSize(new LogicalSize(windowWidth, totalHeight));

			return { width, height, size: base, windowWidth, windowHeight };
		},
	);

	let cameraCanvasRef: HTMLCanvasElement | undefined;

	createEffect(
		on(
			() => rawOptions.cameraLabel,
			(label) => {
				if (label === null) getCurrentWindow().close();
			},
			{ defer: true },
		),
	);

	onMount(() => getCurrentWindow().show());

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-col w-screen h-screen cursor-move group"
			style={{ "border-radius": cameraBorderRadius(state) }}
		>
			<Show when={props.disconnected()}>
				<CameraDisconnectedOverlay />
			</Show>
			<div class="h-14">
				<div class="flex flex-row justify-center items-center">
					<div
						class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10"
						style={{ transform: `scale(${scale()})` }}
					>
						<ControlButton onClick={() => getCurrentWindow().close()}>
							<IconCapCircleX class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.size >= CAMERA_PRESET_LARGE}
							onClick={() => {
								setState(
									"size",
									state.size < CAMERA_PRESET_LARGE
										? CAMERA_PRESET_LARGE
										: CAMERA_PRESET_SMALL,
								);
							}}
						>
							<IconCapEnlarge class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.shape !== "round"}
							onClick={() =>
								setState("shape", (s) =>
									s === "round" ? "square" : s === "square" ? "full" : "round",
								)
							}
						>
							{state.shape === "round" && <IconCapCircle class="size-5.5" />}
							{state.shape === "square" && <IconCapSquare class="size-5.5" />}
							{state.shape === "full" && (
								<IconLucideRectangleHorizontal class="size-5.5" />
							)}
						</ControlButton>
						<ControlButton
							pressed={state.mirrored}
							onClick={() => setState("mirrored", (m) => !m)}
						>
							<IconCapArrows class="size-5.5" />
						</ControlButton>
					</div>
				</div>
			</div>
			<div
				class="absolute top-0 left-0 w-4 h-4 cursor-nw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("nw")}
			/>
			<div
				class="absolute top-0 right-0 w-4 h-4 cursor-ne-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("ne")}
			/>
			<div
				class="absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("sw")}
			/>
			<div
				class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
				style={{ "pointer-events": "auto" }}
				onMouseDown={handleResizeStart("se")}
			/>
			<div
				class={cx(
					"flex flex-col flex-1 relative overflow-hidden pointer-events-none border-none shadow-lg bg-gray-1 text-gray-12",
					state.shape === "round" ? "rounded-full" : "rounded-3xl",
				)}
				data-tauri-drag-region
			>
				<Suspense fallback={<CameraLoadingState />}>
					<Show when={latestFrame() !== null && latestFrame() !== undefined}>
						<Canvas
							latestFrame={latestFrame}
							state={state}
							ref={cameraCanvasRef}
						/>
					</Show>
				</Suspense>
			</div>
		</div>
	);
}

function Canvas(props: {
	latestFrame: Accessor<{ width: number; data: ImageData } | null | undefined>;
	state: CameraWindowState;
	ref: HTMLCanvasElement | undefined;
}) {
	const style = () => {
		const frame = props.latestFrame();
		if (!frame) return {};

		const aspectRatio = frame.data.width / frame.data.height;

		// Use state.size directly for immediate feedback
		const base = props.state.size;

		// Replicate window size logic synchronously for the canvas
		const winWidth =
			props.state.shape === "full"
				? aspectRatio >= 1
					? base * aspectRatio
					: base
				: base;
		const winHeight =
			props.state.shape === "full"
				? aspectRatio >= 1
					? base
					: base / aspectRatio
				: base;

		if (props.state.shape === "full") {
			return {
				width: `${winWidth}px`,
				height: `${winHeight}px`,
				transform: props.state.mirrored ? "scaleX(-1)" : "scaleX(1)",
			};
		}

		const size = (() => {
			if (aspectRatio > 1)
				return {
					width: base * aspectRatio,
					height: base,
				};
			else
				return {
					width: base,
					height: base * aspectRatio,
				};
		})();

		const left = aspectRatio > 1 ? (size.width - base) / 2 : 0;
		const top = aspectRatio > 1 ? 0 : (base - size.height) / 2;

		return {
			width: `${size.width}px`,
			height: `${size.height}px`,
			left: `-${left}px`,
			top: `-${top}px`,
			transform: props.state.mirrored ? "scaleX(-1)" : "scaleX(1)",
		};
	};

	return (
		<canvas
			data-tauri-drag-region
			class={cx("absolute")}
			style={style()}
			width={props.latestFrame()?.data.width}
			height={props.latestFrame()?.data.height}
			ref={props.ref!}
		/>
	);
}

function CameraLoadingState() {
	return (
		<div class="w-full flex-1 flex items-center justify-center">
			<div class="text-gray-11">Loading camera...</div>
		</div>
	);
}

function cameraBorderRadius(state: CameraWindowState) {
	if (state.shape === "round") return "9999px";
	const normalized =
		(state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
	const radius = 3 + normalized * 1.5;
	return `${radius}rem`;
}

function CameraDisconnectedOverlay() {
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
