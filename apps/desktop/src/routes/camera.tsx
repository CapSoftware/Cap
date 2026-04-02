import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { makePersisted } from "@solid-primitives/storage";
import {
	availableMonitors,
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
import { createStore, type SetStoreFunction } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCameraMutation } from "~/utils/queries";
import { createLazySignal } from "~/utils/socket";
import { commands, events } from "~/utils/tauri";
import { RecordingOptionsProvider } from "./(window-chrome)/OptionsContext";

type CameraWindowShape = "round" | "square" | "full";
type BackgroundBlurMode = "off" | "light" | "heavy";
type CameraWindowState = {
	size: number;
	shape: CameraWindowShape;
	mirrored: boolean;
	backgroundBlur: BackgroundBlurMode | boolean;
};

const CAMERA_MIN_SIZE = 150;
const CAMERA_MAX_SIZE = 600;
const CAMERA_DEFAULT_SIZE = 230;
const CAMERA_PRESET_SMALL = 230;
const CAMERA_PRESET_LARGE = 400;

const getCameraOnlyMode = () => {
	return window.__CAP__?.cameraOnlyMode === true;
};

const getCameraOnlyInitialState = (): CameraWindowState => ({
	size: CAMERA_PRESET_LARGE,
	shape: "full",
	mirrored: false,
	backgroundBlur: "off",
});

const BLUR_MODES: BackgroundBlurMode[] = ["off", "light", "heavy"];

const cycleBlurMode = (
	current: BackgroundBlurMode | boolean,
): BackgroundBlurMode => {
	if (typeof current === "boolean") {
		return current ? "heavy" : "light";
	}
	const idx = BLUR_MODES.indexOf(current);
	return BLUR_MODES[(idx + 1) % BLUR_MODES.length];
};

const blurModeLabel = (mode: BackgroundBlurMode | boolean): string => {
	if (typeof mode === "boolean") return mode ? "Blur" : "";
	switch (mode) {
		case "light":
			return "Light";
		case "heavy":
			return "Heavy";
		default:
			return "";
	}
};

let ignoreMoveUntil = 0;

const ignoreMoveFor = (durationMs: number) => {
	ignoreMoveUntil = Date.now() + durationMs;
};

const shouldIgnoreMove = () => Date.now() < ignoreMoveUntil;

const queueCameraPositionSave = (() => {
	let pending: { x: number; y: number } | null = null;
	let timeout: ReturnType<typeof setTimeout> | null = null;

	return (pos: { x: number; y: number }) => {
		pending = pos;
		if (timeout) return;
		timeout = setTimeout(async () => {
			timeout = null;
			const next = pending;
			pending = null;
			if (!next || shouldIgnoreMove()) return;
			try {
				await commands.setCameraWindowPosition(next.x, next.y);
			} catch (error) {
				console.error("Failed to save camera window position", error);
			}
		}, 200);
	};
})();

async function centerCurrentWindow() {
	const monitor = await currentMonitor();
	if (!monitor) return;
	const window = getCurrentWindow();
	const scaleFactor = monitor.scaleFactor;
	const monitorPosition = monitor.position.toLogical(scaleFactor);
	const monitorSize = monitor.size.toLogical(scaleFactor);
	const windowSize = (await window.outerSize()).toLogical(scaleFactor);
	const x = monitorPosition.x + (monitorSize.width - windowSize.width) / 2;
	const y = monitorPosition.y + (monitorSize.height - windowSize.height) / 2;
	await window.setPosition(new LogicalPosition(x, y));
}

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

	onMount(() => {
		const currentWindow = getCurrentWindow();
		let unlistenMoved: (() => void) | null = null;
		let syncingPosition = false;
		let lastSavedPosition: { x: number; y: number } | null = null;
		const queueIfChanged = (x: number, y: number) => {
			if (shouldIgnoreMove()) return;
			if (
				lastSavedPosition &&
				Math.abs(lastSavedPosition.x - x) < 1 &&
				Math.abs(lastSavedPosition.y - y) < 1
			) {
				return;
			}
			lastSavedPosition = { x, y };
			queueCameraPositionSave({ x, y });
		};
		const syncCurrentPosition = async () => {
			if (syncingPosition || shouldIgnoreMove()) return;
			syncingPosition = true;
			try {
				const scaleFactor = await currentWindow.scaleFactor();
				const outerPosition = await currentWindow.outerPosition();
				const logicalPosition = outerPosition.toLogical(scaleFactor);
				queueIfChanged(logicalPosition.x, logicalPosition.y);
			} catch (error) {
				console.error("Failed to read camera window position", error);
			}
			syncingPosition = false;
		};

		void currentWindow
			.onMoved(async ({ payload }) => {
				const scaleFactor = await currentWindow.scaleFactor();
				const logicalPos = payload.toLogical(scaleFactor);
				queueIfChanged(logicalPos.x, logicalPos.y);
			})
			.then((unlisten) => {
				unlistenMoved = unlisten;
			});

		const interval = window.setInterval(() => {
			void syncCurrentPosition();
		}, 400);

		onCleanup(() => {
			window.clearInterval(interval);
			unlistenMoved?.();
		});
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
	const isCameraOnlyMode = () => getCameraOnlyMode();

	const [state, setState] = makePersisted(
		createStore<CameraWindowState>(
			isCameraOnlyMode()
				? getCameraOnlyInitialState()
				: {
						size: CAMERA_DEFAULT_SIZE,
						shape: "round",
						mirrored: false,
						backgroundBlur: "off" as BackgroundBlurMode,
					},
		),
		{ name: "cameraWindowState" },
	);

	const applyCameraOnlyDefaults = () => {
		const cameraOnlyState = getCameraOnlyInitialState();
		setState("size", cameraOnlyState.size);
		setState("shape", cameraOnlyState.shape);
	};

	const centerCameraOnlyWindow = () => {
		applyCameraOnlyDefaults();
		ignoreMoveFor(1500);
		void commands.ignoreCameraWindowPosition(1500);
		void centerCurrentWindow();
		setTimeout(() => {
			void centerCurrentWindow();
		}, 120);
	};

	onMount(() => {
		if (isCameraOnlyMode()) {
			centerCameraOnlyWindow();
		}

		const handleVisibilityChange = () => {
			if (!document.hidden) {
				setTimeout(() => {
					commands.refreshCameraFeed().catch(() => {});
				}, 500);
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		onCleanup(() =>
			document.removeEventListener("visibilitychange", handleVisibilityChange),
		);
	});

	createEffect(
		on(
			() => isCameraOnlyMode(),
			(isCameraOnly, wasCameraOnly) => {
				if (isCameraOnly && !wasCameraOnly) {
					centerCameraOnlyWindow();
				}
			},
		),
	);

	createEffect(() => {
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
		commands.setCameraPreviewState({
			size: state.size,
			shape: state.shape,
			mirrored: state.mirrored,
			background_blur:
				(typeof state.backgroundBlur === "boolean"
					? state.backgroundBlur
						? "heavy"
						: "off"
					: state.backgroundBlur) ?? "off",
		});
	});

	const [cameraPreviewReady] = createResource(() =>
		commands.awaitCameraPreviewReady(),
	);

	const _setCamera = createCameraMutation();

	const scale = () => {
		const normalized =
			(state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
		return 0.7 + normalized * 0.3;
	};

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
						class="flex flex-row gap-1 p-1 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10"
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
						<ControlButton
							pressed={
								state.backgroundBlur !== "off" && state.backgroundBlur !== false
							}
							onClick={() =>
								setState("backgroundBlur", (b) => cycleBlurMode(b))
							}
						>
							<div class="relative">
								<IconLucidePersonStanding class="size-5.5" />
								<Show
									when={
										state.backgroundBlur !== "off" &&
										state.backgroundBlur !== false
									}
								>
									<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[7px] font-bold leading-none whitespace-nowrap">
										{blurModeLabel(state.backgroundBlur)}
									</span>
								</Show>
							</div>
						</ControlButton>
					</div>
				</div>
			</div>

			<CameraResizeHandles
				state={state}
				setState={setState}
				toolbarHeight={52}
			/>

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

type ResizeCorner = "nw" | "ne" | "sw" | "se";

const RESIZE_CORNERS: readonly ResizeCorner[] = ["nw", "ne", "sw", "se"];

function CameraResizeHandles(props: {
	state: CameraWindowState;
	setState: SetStoreFunction<CameraWindowState>;
	toolbarHeight: number;
}) {
	const [isResizing, setIsResizing] = createSignal(false);
	const [activeCorner, setActiveCorner] = createSignal<ResizeCorner | null>(
		null,
	);
	const [resizeStart, setResizeStart] = createSignal({
		size: 0,
		x: 0,
		y: 0,
		corner: "nw" as ResizeCorner,
	});

	const handleResizeStart = (corner: ResizeCorner) => (e: MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		setIsResizing(true);
		setActiveCorner(corner);
		setResizeStart({
			size: props.state.size,
			x: e.clientX,
			y: e.clientY,
			corner,
		});
	};

	const handleResizeMove = (e: MouseEvent) => {
		if (!isResizing()) return;
		const start = resizeStart();
		const deltaX = e.clientX - start.x;
		const deltaY = e.clientY - start.y;

		const hasE = start.corner.includes("e");
		const hasW = start.corner.includes("w");
		const hasS = start.corner.includes("s");
		const hasN = start.corner.includes("n");

		const dx = hasE ? deltaX : hasW ? -deltaX : 0;
		const dy = hasS ? deltaY : hasN ? -deltaY : 0;

		const delta = (hasE || hasW) && (hasN || hasS) ? Math.max(dx, dy) : dx + dy;

		const newSize = Math.max(
			CAMERA_MIN_SIZE,
			Math.min(CAMERA_MAX_SIZE, start.size + delta),
		);
		props.setState("size", newSize);
	};

	const handleResizeEnd = () => {
		setIsResizing(false);
		setActiveCorner(null);
	};

	createEffect(() => {
		if (!isResizing()) return;
		window.addEventListener("mousemove", handleResizeMove);
		window.addEventListener("mouseup", handleResizeEnd);
		onCleanup(() => {
			window.removeEventListener("mousemove", handleResizeMove);
			window.removeEventListener("mouseup", handleResizeEnd);
		});
	});

	return (
		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 z-20"
			style={{ top: `${props.toolbarHeight}px` }}
		>
			{RESIZE_CORNERS.map((corner) => (
				<ResizeCornerHandle
					corner={corner}
					onMouseDown={handleResizeStart(corner)}
					active={activeCorner() === corner}
				/>
			))}
		</div>
	);
}

function ResizeCornerHandle(props: {
	corner: ResizeCorner;
	onMouseDown: (e: MouseEvent) => void;
	active: boolean;
}) {
	const hitAreaClass = () => {
		switch (props.corner) {
			case "nw":
				return "top-0 left-0 cursor-nw-resize";
			case "ne":
				return "top-0 right-0 cursor-ne-resize";
			case "sw":
				return "bottom-0 left-0 cursor-sw-resize";
			case "se":
				return "bottom-0 right-0 cursor-se-resize";
		}
	};

	const bracketPositionClass = () => {
		switch (props.corner) {
			case "nw":
				return "top-1.5 left-1.5 border-t-2 border-l-2 rounded-tl-[6px]";
			case "ne":
				return "top-1.5 right-1.5 border-t-2 border-r-2 rounded-tr-[6px]";
			case "sw":
				return "bottom-1.5 left-1.5 border-b-2 border-l-2 rounded-bl-[6px]";
			case "se":
				return "bottom-1.5 right-1.5 border-b-2 border-r-2 rounded-br-[6px]";
		}
	};

	return (
		<div
			data-tauri-drag-region="false"
			class={cx(
				"absolute z-20 w-7 h-7 group/handle select-none",
				hitAreaClass(),
			)}
			style={{ "pointer-events": "auto" }}
			onMouseDown={props.onMouseDown}
		>
			<div
				class={cx(
					"absolute w-3.5 h-3.5 border-white pointer-events-none",
					"transition-[opacity,transform,border-color] duration-150 ease-out",
					"opacity-0 scale-90",
					"group-hover:opacity-70 group-hover:scale-100",
					"group-hover/handle:!opacity-100 group-hover/handle:!scale-110",
					props.active && "!opacity-100 !scale-110",
					bracketPositionClass(),
				)}
				style={{
					filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))",
				}}
			/>
		</div>
	);
}

// Legacy stuff below

function LegacyCameraPreviewPage(props: { disconnected: Accessor<boolean> }) {
	const isCameraOnlyMode = () => getCameraOnlyMode();

	const [state, setState] = makePersisted(
		createStore<CameraWindowState>(
			isCameraOnlyMode()
				? getCameraOnlyInitialState()
				: {
						size: CAMERA_DEFAULT_SIZE,
						shape: "round",
						mirrored: false,
						backgroundBlur: "off" as BackgroundBlurMode,
					},
		),
		{ name: "cameraWindowState" },
	);

	const applyCameraOnlyDefaults = () => {
		const cameraOnlyState = getCameraOnlyInitialState();
		setState("size", cameraOnlyState.size);
		setState("shape", cameraOnlyState.shape);
	};

	const centerCameraOnlyWindow = () => {
		applyCameraOnlyDefaults();
		ignoreMoveFor(1500);
		void commands.ignoreCameraWindowPosition(1500);
		void centerCurrentWindow();
		setTimeout(() => {
			void centerCurrentWindow();
		}, 120);
	};

	onMount(() => {
		if (isCameraOnlyMode()) {
			centerCameraOnlyWindow();
		}
	});

	createEffect(
		on(
			() => isCameraOnlyMode(),
			(isCameraOnly, wasCameraOnly) => {
				if (isCameraOnly && !wasCameraOnly) {
					centerCameraOnlyWindow();
				}
			},
		),
	);

	createEffect(() => {
		const currentSize = state.size as number | string;
		if (typeof currentSize !== "number" || Number.isNaN(currentSize)) {
			setState(
				"size",
				currentSize === "lg" ? CAMERA_PRESET_LARGE : CAMERA_DEFAULT_SIZE,
			);
		}
	});

	createEffect(() => {
		commands.setCameraPreviewState({
			size: state.size,
			shape: state.shape,
			mirrored: state.mirrored,
			background_blur:
				(typeof state.backgroundBlur === "boolean"
					? state.backgroundBlur
						? "heavy"
						: "off"
					: state.backgroundBlur) ?? "off",
		});
	});

	const [hasPositioned, setHasPositioned] = createSignal(isCameraOnlyMode());

	const [latestFrame, setLatestFrame] = createLazySignal<{
		width: number;
		data: ImageData;
	} | null>();
	let reusableFrameData: ImageData | null = null;
	let reusableFrameWidth = 0;
	let reusableFrameHeight = 0;

	const [frameDimensions, setFrameDimensions] = createSignal<{
		width: number;
		height: number;
	} | null>(null);

	const [externalContainerSize, setExternalContainerSize] = createSignal<{
		width: number;
		height: number;
	} | null>(null);

	let containerRef: HTMLDivElement | undefined;

	onMount(() => {
		if (!containerRef) return;

		const updateContainerSize = () => {
			if (!containerRef) return;
			const rect = containerRef.getBoundingClientRect();
			const currentSize = externalContainerSize();
			if (
				!currentSize ||
				Math.abs(currentSize.width - rect.width) > 1 ||
				Math.abs(currentSize.height - rect.height) > 1
			) {
				setExternalContainerSize({ width: rect.width, height: rect.height });
			}
		};

		const resizeObserver = new ResizeObserver(updateContainerSize);
		resizeObserver.observe(containerRef);
		updateContainerSize();

		onCleanup(() => resizeObserver.disconnect());
	});

	function getReusableFrameData(width: number, height: number) {
		if (
			!reusableFrameData ||
			reusableFrameWidth !== width ||
			reusableFrameHeight !== height
		) {
			reusableFrameData = new ImageData(width, height);
			reusableFrameWidth = width;
			reusableFrameHeight = height;
		}

		return reusableFrameData;
	}

	let pendingRender = false;
	let rafId: number | null = null;
	let cachedCtx: CanvasRenderingContext2D | null = null;

	function scheduleRender() {
		if (rafId !== null) return;
		rafId = requestAnimationFrame(() => {
			rafId = null;
			if (!pendingRender) return;
			pendingRender = false;

			if (!cachedCtx && cameraCanvasRef) {
				cachedCtx = cameraCanvasRef.getContext("2d");
			}
			if (cachedCtx && reusableFrameData) {
				cachedCtx.putImageData(reusableFrameData, 0, 0);
			}
		});
	}

	function imageDataHandler(imageData: { width: number; data: ImageData }) {
		const currentFrame = latestFrame();
		if (
			!currentFrame ||
			currentFrame.data !== imageData.data ||
			currentFrame.data.width !== imageData.data.width ||
			currentFrame.data.height !== imageData.data.height
		) {
			setLatestFrame(imageData);
		}

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

		pendingRender = true;
		scheduleRender();
	}

	const STALL_TIMEOUT_MS = 2000;

	const { cameraWsPort } = window.__CAP__;
	const [isWindowVisible, setIsWindowVisible] = createSignal(!document.hidden);
	const [_isConnected, setIsConnected] = createSignal(false);
	let ws: WebSocket | undefined;
	let reconnectInterval: ReturnType<typeof setInterval> | undefined;
	let stallCheckInterval: ReturnType<typeof setInterval> | undefined;
	let lastFrameTime = 0;

	onMount(() => {
		const handleVisibilityChange = () => {
			setIsWindowVisible(!document.hidden);
			if (!document.hidden) {
				lastFrameTime = Date.now();
				commands.refreshCameraFeed().catch(() => {});
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		onCleanup(() =>
			document.removeEventListener("visibilitychange", handleVisibilityChange),
		);
	});

	const createSocket = () => {
		const socket = new WebSocket(`ws://localhost:${cameraWsPort}`);
		socket.binaryType = "arraybuffer";

		socket.addEventListener("open", () => {
			setIsConnected(true);
			lastFrameTime = Date.now();
			reusableFrameData = null;
			reusableFrameWidth = 0;
			reusableFrameHeight = 0;
			if (cachedCtx && cameraCanvasRef) {
				cachedCtx.clearRect(
					0,
					0,
					cameraCanvasRef.width,
					cameraCanvasRef.height,
				);
			}
		});

		socket.addEventListener("close", () => {
			setIsConnected(false);
		});

		socket.addEventListener("error", () => {
			setIsConnected(false);
		});

		socket.onmessage = (event) => {
			if (!isWindowVisible()) return;

			lastFrameTime = Date.now();

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

			const imageData = getReusableFrameData(width, height);
			if (strideBytes === expectedRowBytes) {
				imageData.data.set(source.subarray(0, expectedLength));
			} else {
				for (let row = 0; row < height; row += 1) {
					const srcStart = row * strideBytes;
					const destStart = row * expectedRowBytes;
					imageData.data.set(
						source.subarray(srcStart, srcStart + expectedRowBytes),
						destStart,
					);
				}
			}
			imageDataHandler({ width, data: imageData });
		};

		return socket;
	};

	const stopSocket = () => {
		if (reconnectInterval) {
			clearInterval(reconnectInterval);
			reconnectInterval = undefined;
		}

		if (stallCheckInterval) {
			clearInterval(stallCheckInterval);
			stallCheckInterval = undefined;
		}

		if (ws) {
			ws.close();
			ws = undefined;
		}

		setIsConnected(false);
	};

	const startSocket = () => {
		if (ws || !isWindowVisible()) return;

		lastFrameTime = Date.now();
		ws = createSocket();

		reconnectInterval = setInterval(() => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				if (ws) ws.close();
				ws = createSocket();
			}
		}, 5000);

		stallCheckInterval = setInterval(() => {
			if (
				ws?.readyState === WebSocket.OPEN &&
				isWindowVisible() &&
				lastFrameTime > 0 &&
				Date.now() - lastFrameTime > STALL_TIMEOUT_MS
			) {
				lastFrameTime = Date.now();
				commands.refreshCameraFeed().catch(() => {});
				if (ws) ws.close();
				ws = createSocket();
			}
		}, STALL_TIMEOUT_MS);
	};

	createEffect(() => {
		if (isWindowVisible()) {
			startSocket();
		} else {
			stopSocket();
		}
	});

	onCleanup(() => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		cachedCtx = null;
		reusableFrameData = null;
		reusableFrameWidth = 0;
		reusableFrameHeight = 0;
		stopSocket();
	});

	const scale = () => {
		const normalized =
			(state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
		return 0.7 + normalized * 0.3;
	};

	const [_windowSize] = createResource(
		() =>
			[
				state.size,
				state.shape,
				frameDimensions()?.width,
				frameDimensions()?.height,
			] as const,
		async ([size, shape, frameWidth, frameHeight]) => {
			const BAR_HEIGHT = 56;
			const base = Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, size));
			const aspect = frameWidth && frameHeight ? frameWidth / frameHeight : 1;
			const windowWidth =
				shape === "full" ? (aspect >= 1 ? base * aspect : base) : base;
			const windowHeight =
				shape === "full" ? (aspect >= 1 ? base : base / aspect) : base;
			const totalHeight = windowHeight + BAR_HEIGHT;

			const currentWindow = getCurrentWindow();
			await currentWindow.setSize(new LogicalSize(windowWidth, totalHeight));

			const monitor = await currentMonitor();
			const monitors = await availableMonitors();
			const activeMonitor = monitor ?? monitors[0];
			if (!activeMonitor) {
				return { size: base, windowWidth, windowHeight };
			}

			const scalingFactor = activeMonitor.scaleFactor;
			const width =
				activeMonitor.size.width / scalingFactor - windowWidth - 100;
			const height =
				activeMonitor.size.height / scalingFactor - totalHeight - 100;

			if (!hasPositioned()) {
				ignoreMoveFor(1500);
				const settings = await generalSettingsStore.get();
				const saved = settings?.cameraWindowPosition ?? null;
				if (saved) {
					const onMonitor = monitors.some((m) => {
						const scale = m.scaleFactor;
						const pos = m.position.toLogical(scale);
						const size = m.size.toLogical(scale);
						return (
							saved.x >= pos.x &&
							saved.x < pos.x + size.width &&
							saved.y >= pos.y &&
							saved.y < pos.y + size.height
						);
					});
					if (onMonitor) {
						currentWindow.setPosition(new LogicalPosition(saved.x, saved.y));
					} else {
						currentWindow.setPosition(
							new LogicalPosition(
								width + activeMonitor.position.toLogical(scalingFactor).x,
								height + activeMonitor.position.toLogical(scalingFactor).y,
							),
						);
					}
				} else {
					currentWindow.setPosition(
						new LogicalPosition(
							width + activeMonitor.position.toLogical(scalingFactor).x,
							height + activeMonitor.position.toLogical(scalingFactor).y,
						),
					);
				}
				setHasPositioned(true);
			} else {
				const outerPos = await currentWindow.outerPosition();
				const logicalPos = outerPos.toLogical(scalingFactor);
				const monitorLogicalPos =
					activeMonitor.position.toLogical(scalingFactor);
				const monitorLogicalSize = activeMonitor.size.toLogical(scalingFactor);

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
					ignoreMoveFor(1000);
					await currentWindow.setPosition(new LogicalPosition(newX, newY));
				}
			}

			return { width, height, size: base, windowWidth, windowHeight };
		},
	);

	let cameraCanvasRef: HTMLCanvasElement | undefined;

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
						class="flex flex-row gap-1 p-1 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10"
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
						<ControlButton
							pressed={
								state.backgroundBlur !== "off" && state.backgroundBlur !== false
							}
							onClick={() =>
								setState("backgroundBlur", (b) => cycleBlurMode(b))
							}
						>
							<div class="relative">
								<IconLucidePersonStanding class="size-5.5" />
								<Show
									when={
										state.backgroundBlur !== "off" &&
										state.backgroundBlur !== false
									}
								>
									<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[7px] font-bold leading-none whitespace-nowrap">
										{blurModeLabel(state.backgroundBlur)}
									</span>
								</Show>
							</div>
						</ControlButton>
					</div>
				</div>
			</div>
			<CameraResizeHandles
				state={state}
				setState={setState}
				toolbarHeight={56}
			/>
			<div
				ref={containerRef}
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
							containerSize={externalContainerSize() ?? undefined}
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
	containerSize?: { width: number; height: number };
}) {
	const style = () => {
		const frame = props.latestFrame();
		if (!frame) return {};

		const aspectRatio = frame.data.width / frame.data.height;

		// Use container size if available (for external resize), otherwise use state.size
		const base = props.containerSize
			? Math.min(props.containerSize.width, props.containerSize.height)
			: props.state.size;

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
					height: base / aspectRatio,
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
			ref={props.ref}
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
			class="absolute inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs px-4 pointer-events-none"
			style={{ "border-radius": "inherit" }}
		>
			<p class="text-center text-sm font-medium text-white/90">
				Camera disconnected
			</p>
		</div>
	);
}
