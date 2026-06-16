import { makePersisted } from "@solid-primitives/storage";
import { listen } from "@tauri-apps/api/event";
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
import {
	CAMERA_DEFAULT_SIZE,
	CAMERA_MAX_SIZE,
	CAMERA_MIN_SIZE,
	CAMERA_PRESET_LARGE,
	CAMERA_TOOLBAR_HEIGHT,
	CAMERA_WINDOW_STATE_STORAGE_KEY,
	CameraPreviewToolbar,
	CameraResizeHandles,
	type CameraWindowState,
	cameraBorderRadius,
	cameraPreviewDimensions,
	cameraToolbarScale,
	getDefaultCameraWindowState,
	normalizeBackgroundBlurMode,
} from "~/components/CameraPreviewChrome";
import { generalSettingsStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCameraMutation } from "~/utils/queries";
import {
	type CanvasControls,
	createImageDataWS,
	type FrameData,
} from "~/utils/socket";
import { commands, events } from "~/utils/tauri";
import { RecordingOptionsProvider } from "./(window-chrome)/OptionsContext";

type CameraPreviewIssue = {
	title: string;
	message: string;
};

const CAMERA_PREVIEW_ERROR_EVENT = "camera-preview-error";
const CAMERA_PREVIEW_CLEAR_EVENT = "camera-preview-clear";
const CAMERA_DISCONNECTED_ISSUE: CameraPreviewIssue = {
	title: "Camera disconnected",
	message: "The selected camera stopped sending video.",
};

const getCameraOnlyMode = () => {
	return window.__CAP__?.cameraOnlyMode === true;
};

const getNativeCameraPreviewInitialState = () => {
	return window.__CAP__?.enableNativeCameraPreview === true;
};

let ignoreMoveUntil = 0;

const ignoreMoveFor = (durationMs: number) => {
	ignoreMoveUntil = Date.now() + durationMs;
};

const shouldIgnoreMove = () => Date.now() < ignoreMoveUntil;

function createCameraWindowChromeVisibility() {
	const [visible, setVisible] = createSignal(false);

	return {
		visible,
		show: () => setVisible(true),
		hide: () => setVisible(false),
	};
}

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
	const isNativePreviewEnabled = () => {
		if (type() === "windows") return false;
		if (generalSettings.isPending) return getNativeCameraPreviewInitialState();
		return (
			generalSettings.data?.enableNativeCameraPreview ??
			getNativeCameraPreviewInitialState()
		);
	};

	const [cameraIssue, setCameraIssue] = createSignal<CameraPreviewIssue | null>(
		null,
	);

	const unlistenCameraPreviewError = listen<CameraPreviewIssue>(
		CAMERA_PREVIEW_ERROR_EVENT,
		({ payload }) => setCameraIssue(payload),
	);
	const unlistenCameraPreviewClear = listen(CAMERA_PREVIEW_CLEAR_EVENT, () =>
		setCameraIssue(null),
	);
	onCleanup(() => {
		void unlistenCameraPreviewError.then((unlisten) => unlisten());
		void unlistenCameraPreviewClear.then((unlisten) => unlisten());
	});

	createTauriEventListener(events.recordingEvent, (payload) => {
		if (payload.variant === "InputLost" && payload.input === "camera") {
			setCameraIssue(CAMERA_DISCONNECTED_ISSUE);
		} else if (
			payload.variant === "InputRestored" &&
			payload.input === "camera"
		) {
			setCameraIssue(null);
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
				when={isNativePreviewEnabled()}
				fallback={<LegacyCameraPreviewPage issue={cameraIssue} />}
			>
				<NativeCameraPreviewPage issue={cameraIssue} />
			</Show>
		</RecordingOptionsProvider>
	);
}

function NativeCameraPreviewPage(props: {
	issue: Accessor<CameraPreviewIssue | null>;
}) {
	const isCameraOnlyMode = () => getCameraOnlyMode();

	const [state, setState] = makePersisted(
		createStore<CameraWindowState>(getDefaultCameraWindowState()),
		{ name: CAMERA_WINDOW_STATE_STORAGE_KEY },
	);

	const centerCameraOnlyWindow = () => {
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
			background_blur: normalizeBackgroundBlurMode(state.backgroundBlur),
		});
	});

	const [cameraPreviewReady] = createResource(() =>
		commands.awaitCameraPreviewReady(),
	);

	const _setCamera = createCameraMutation();

	const scale = () => cameraToolbarScale(state.size);
	const chrome = createCameraWindowChromeVisibility();

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-col w-screen h-screen cursor-move"
			onPointerMove={chrome.show}
			onPointerLeave={chrome.hide}
			onPointerCancel={chrome.hide}
		>
			<Show when={props.issue()}>
				{(issue) => (
					<CameraIssueOverlay
						issue={issue()}
						size={state.size}
						class="inset-x-0 bottom-0"
						top={CAMERA_TOOLBAR_HEIGHT}
						borderRadius={cameraBorderRadius(state)}
					/>
				)}
			</Show>
			<div class="h-14">
				<div class="flex flex-row justify-center items-center">
					<CameraPreviewToolbar
						state={state}
						setState={setState}
						visible={chrome.visible()}
						scale={scale()}
						onClose={() => getCurrentWindow().close()}
					/>
				</div>
			</div>

			<CameraResizeHandles
				state={state}
				setState={setState}
				toolbarHeight={CAMERA_TOOLBAR_HEIGHT}
				visible={chrome.visible()}
			/>

			<Show when={cameraPreviewReady.loading}>
				<div class="w-full flex-1 flex items-center justify-center">
					<div class="text-gray-11">Loading camera...</div>
				</div>
			</Show>
		</div>
	);
}

// Legacy stuff below

function LegacyCameraPreviewPage(props: {
	issue: Accessor<CameraPreviewIssue | null>;
}) {
	const isCameraOnlyMode = () => getCameraOnlyMode();

	const [state, setState] = makePersisted(
		createStore<CameraWindowState>(getDefaultCameraWindowState()),
		{ name: CAMERA_WINDOW_STATE_STORAGE_KEY },
	);

	const centerCameraOnlyWindow = () => {
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
			background_blur: normalizeBackgroundBlurMode(state.backgroundBlur),
		});
	});

	const [hasPositioned, setHasPositioned] = createSignal(isCameraOnlyMode());

	const [hasFrame, setHasFrame] = createSignal(false);
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

	const STALL_TIMEOUT_MS = 2000;
	const WS_INITIAL_BACKOFF_MS = 1000;
	const WS_MAX_BACKOFF_MS = 30000;
	const WS_MAX_RETRIES = 10;

	const { cameraWsPort } = window.__CAP__;
	const [isWindowVisible, setIsWindowVisible] = createSignal(!document.hidden);
	let ws: Omit<WebSocket, "onmessage"> | undefined;
	let canvasControls: CanvasControls | undefined;
	let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
	let stallCheckInterval: ReturnType<typeof setInterval> | undefined;
	let retryCount = 0;
	let isCleanedUp = false;
	let lastFrameTime = 0;
	let cameraCanvasRef: HTMLCanvasElement | undefined;

	const closeSocket = () => {
		const socket = ws;
		const controls = canvasControls;
		ws = undefined;
		canvasControls = undefined;
		controls?.dispose();
		if (
			socket &&
			socket.readyState !== WebSocket.CLOSING &&
			socket.readyState !== WebSocket.CLOSED
		) {
			socket.close();
		}
	};

	const initCanvasControls = () => {
		if (!canvasControls || !cameraCanvasRef) return;
		canvasControls.initDirectCanvas(cameraCanvasRef);
	};

	const updateFrameState = (frame: FrameData) => {
		retryCount = 0;
		lastFrameTime = Date.now();

		const currentDimensions = frameDimensions();
		if (
			!currentDimensions ||
			currentDimensions.width !== frame.width ||
			currentDimensions.height !== frame.height
		) {
			setFrameDimensions({ width: frame.width, height: frame.height });
		}
		if (canvasControls?.hasRenderedFrame()) {
			setHasFrame(true);
		}
	};

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
		const [socket, _isConnected, _isWorkerReady, controls] = createImageDataWS(
			`ws://localhost:${cameraWsPort}`,
			updateFrameState,
			() => commands.refreshCameraFeed().catch(() => {}),
			{ powerPreference: "low-power" },
		);
		canvasControls = controls;
		initCanvasControls();

		socket.addEventListener("open", () => {
			lastFrameTime = Date.now();
			setHasFrame(false);
			setFrameDimensions(null);
		});

		socket.addEventListener("close", () => {
			if (canvasControls === controls) {
				canvasControls = undefined;
			}
			if (ws === socket) ws = undefined;
			scheduleReconnect();
		});

		socket.addEventListener("error", () => {
			controls.dispose();
		});

		return socket;
	};

	const scheduleReconnect = () => {
		if (
			isCleanedUp ||
			reconnectTimeout ||
			ws ||
			!isWindowVisible() ||
			retryCount >= WS_MAX_RETRIES
		) {
			return;
		}

		const backoffMs = Math.min(
			WS_INITIAL_BACKOFF_MS * 2 ** retryCount,
			WS_MAX_BACKOFF_MS,
		);

		reconnectTimeout = setTimeout(() => {
			reconnectTimeout = undefined;
			if (isCleanedUp || ws || !isWindowVisible()) return;
			retryCount += 1;
			lastFrameTime = Date.now();
			ws = createSocket();
		}, backoffMs);
	};

	const stopSocket = () => {
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = undefined;
		}

		if (stallCheckInterval) {
			clearInterval(stallCheckInterval);
			stallCheckInterval = undefined;
		}

		closeSocket();
	};

	const startSocket = () => {
		if (ws || !isWindowVisible()) return;

		retryCount = 0;
		lastFrameTime = Date.now();
		ws = createSocket();

		stallCheckInterval = setInterval(() => {
			if (
				ws?.readyState === WebSocket.OPEN &&
				isWindowVisible() &&
				lastFrameTime > 0 &&
				Date.now() - lastFrameTime > STALL_TIMEOUT_MS
			) {
				lastFrameTime = Date.now();
				commands.refreshCameraFeed().catch(() => {});
				ws.close();
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
		isCleanedUp = true;
		stopSocket();
	});

	const scale = () => cameraToolbarScale(state.size);
	const chrome = createCameraWindowChromeVisibility();

	const [_windowSize] = createResource(
		() =>
			[
				state.size,
				state.shape,
				frameDimensions()?.width,
				frameDimensions()?.height,
			] as const,
		async ([size, shape, frameWidth, frameHeight]) => {
			const { width: windowWidth, height: windowHeight } =
				cameraPreviewDimensions(
					size,
					shape,
					frameWidth && frameHeight ? frameWidth / frameHeight : undefined,
				);
			const totalHeight = windowHeight + CAMERA_TOOLBAR_HEIGHT;

			const currentWindow = getCurrentWindow();
			await currentWindow.setSize(new LogicalSize(windowWidth, totalHeight));

			const monitor = await currentMonitor();
			const monitors = await availableMonitors();
			const activeMonitor = monitor ?? monitors[0];
			if (!activeMonitor) {
				return {
					size: Math.min(windowWidth, windowHeight),
					windowWidth,
					windowHeight,
				};
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

			return { width, height, size, windowWidth, windowHeight };
		},
	);

	onMount(() => getCurrentWindow().show());

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-col w-screen h-screen cursor-move"
			style={{ "border-radius": cameraBorderRadius(state) }}
			onPointerMove={chrome.show}
			onPointerLeave={chrome.hide}
			onPointerCancel={chrome.hide}
		>
			<div class="h-14">
				<div class="flex flex-row justify-center items-center">
					<CameraPreviewToolbar
						state={state}
						setState={setState}
						visible={chrome.visible()}
						scale={scale()}
						onClose={() => getCurrentWindow().close()}
					/>
				</div>
			</div>
			<CameraResizeHandles
				state={state}
				setState={setState}
				toolbarHeight={CAMERA_TOOLBAR_HEIGHT}
				visible={chrome.visible()}
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
					<Canvas
						frameDimensions={frameDimensions}
						state={state}
						onCanvas={(canvas) => {
							cameraCanvasRef = canvas;
							initCanvasControls();
						}}
						containerSize={externalContainerSize() ?? undefined}
					/>
					<Show when={!hasFrame()}>
						<CameraLoadingState />
					</Show>
				</Suspense>
				<Show when={props.issue()}>
					{(issue) => <CameraIssueOverlay issue={issue()} size={state.size} />}
				</Show>
			</div>
		</div>
	);
}

function Canvas(props: {
	frameDimensions: Accessor<
		{ width: number; height: number } | null | undefined
	>;
	state: CameraWindowState;
	onCanvas: (canvas: HTMLCanvasElement) => void;
	containerSize?: { width: number; height: number };
}) {
	const style = () => {
		const dimensions = props.frameDimensions();
		if (!dimensions) return {};

		const aspectRatio = dimensions.width / dimensions.height;

		const targetSize =
			props.containerSize ??
			cameraPreviewDimensions(props.state.size, props.state.shape, aspectRatio);
		const targetAspectRatio = targetSize.width / targetSize.height;
		const size =
			aspectRatio > targetAspectRatio
				? {
						height: targetSize.height,
						width: targetSize.height * aspectRatio,
					}
				: {
						height: targetSize.width / aspectRatio,
						width: targetSize.width,
					};

		const left = (size.width - targetSize.width) / 2;
		const top = (size.height - targetSize.height) / 2;

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
			ref={(canvas) => props.onCanvas(canvas)}
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

function cameraOverlayTextMetrics(size: number) {
	const normalized =
		(Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, size)) -
			CAMERA_MIN_SIZE) /
		(CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
	const titleSize = 0.75 + normalized * 0.375;
	const messageSize = 0.625 + normalized * 0.25;
	const lineHeight = 1.2 + normalized * 0.2;
	const gap = 0.375 + normalized * 0.25;
	const maxWidth = Math.max(7.5, Math.min(18, size / 16));

	return {
		gap: `${gap}rem`,
		maxWidth: `${maxWidth}rem`,
		messageLineHeight: `${lineHeight}rem`,
		messageSize: `${messageSize}rem`,
		titleSize: `${titleSize}rem`,
	};
}

function CameraIssueOverlay(props: {
	issue: CameraPreviewIssue;
	size: number;
	class?: string;
	top?: number;
	borderRadius?: string;
}) {
	const textMetrics = () => cameraOverlayTextMetrics(props.size);
	const style = () => {
		const base = { "border-radius": props.borderRadius ?? "inherit" };
		if (props.top === undefined) return base;
		return { ...base, top: `${props.top}px` };
	};

	return (
		<div
			class={cx(
				"absolute z-10 flex items-center justify-center overflow-hidden bg-black/75 backdrop-blur-xs px-4 pointer-events-none",
				props.class ?? "inset-0",
			)}
			style={style()}
		>
			<div
				class="flex flex-col items-center text-center text-white"
				style={{ gap: textMetrics().gap, "max-width": textMetrics().maxWidth }}
			>
				<p
					class="font-semibold text-white"
					style={{ "font-size": textMetrics().titleSize }}
				>
					{props.issue.title}
				</p>
				<p
					class="text-white/75"
					style={{
						"font-size": textMetrics().messageSize,
						"line-height": textMetrics().messageLineHeight,
					}}
				>
					{props.issue.message}
				</p>
			</div>
		</div>
	);
}
