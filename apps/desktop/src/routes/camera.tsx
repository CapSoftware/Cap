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
	cameraToolbarScale,
	getDefaultCameraWindowState,
	normalizeBackgroundBlurMode,
} from "~/components/CameraPreviewChrome";
import { generalSettingsStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCameraMutation } from "~/utils/queries";
import { createLazySignal } from "~/utils/socket";
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
			if (pendingRender) return;

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
			const base = Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, size));
			const aspect = frameWidth && frameHeight ? frameWidth / frameHeight : 1;
			const windowWidth =
				shape === "full" ? (aspect >= 1 ? base * aspect : base) : base;
			const windowHeight =
				shape === "full" ? (aspect >= 1 ? base : base / aspect) : base;
			const totalHeight = windowHeight + CAMERA_TOOLBAR_HEIGHT;

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
					<Show when={latestFrame() !== null && latestFrame() !== undefined}>
						<Canvas
							latestFrame={latestFrame}
							state={state}
							ref={cameraCanvasRef}
							containerSize={externalContainerSize() ?? undefined}
						/>
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
