import { Button } from "@cap/ui-solid";
import { createEventListener } from "@solid-primitives/event-listener";
import { useNavigate } from "@solidjs/router";
import { createMutation, queryOptions, useQuery } from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import * as shell from "@tauri-apps/plugin-shell";
import * as updater from "@tauri-apps/plugin-updater";
import { cx } from "cva";
import { createEffect, createMemo, createSignal, ErrorBoundary, onCleanup, onMount, Show, Suspense } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { Transition } from "solid-transition-group";
import Mode from "~/components/Mode";
import Tooltip from "~/components/Tooltip";
import { Input } from "~/routes/editor/ui";
import { authStore, generalSettingsStore } from "~/store";
import { createSignInMutation } from "~/utils/auth";
import { createTauriEventListener } from "~/utils/createEventListener";
import {
	createCameraMutation,
	createCurrentRecordingQuery,
	createLicenseQuery,
	listAudioDevices,
	listDisplaysWithThumbnails,
	listRecordings,
	listScreens,
	listVideoDevices,
	listWindows,
	listWindowsWithThumbnails,
} from "~/utils/queries";
import {
	type CameraInfo,
	type CaptureDisplay,
	type CaptureDisplayWithThumbnail,
	type CaptureWindow,
	type CaptureWindowWithThumbnail,
	commands,
	type DeviceOrModelID,
	events,
	type RecordingTargetMode,
	type ScreenCaptureTarget,
	type UploadProgress,
} from "~/utils/tauri";
import IconCapLogoFull from "~icons/cap/logo-full";
import IconCapLogoFullDark from "~icons/cap/logo-full-dark";
import IconCapSettings from "~icons/cap/settings";
import IconLucideAppWindowMac from "~icons/lucide/app-window-mac";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideBug from "~icons/lucide/bug";
import IconLucideImage from "~icons/lucide/image";
import IconLucideSearch from "~icons/lucide/search";
import IconLucideSquarePlay from "~icons/lucide/square-play";
import IconMaterialSymbolsScreenshotFrame2Rounded from "~icons/material-symbols/screenshot-frame-2-rounded";
import IconMdiMonitor from "~icons/mdi/monitor";
import { WindowChromeHeader } from "../Context";
import { RecordingOptionsProvider, useRecordingOptions } from "../OptionsContext";
import CameraSelect from "./CameraSelect";
import ChangelogButton from "./ChangeLogButton";
import MicrophoneSelect from "./MicrophoneSelect";
import SystemAudio from "./SystemAudio";
import type { RecordingWithPath, ScreenshotWithPath } from "./TargetCard";
import TargetDropdownButton from "./TargetDropdownButton";
import TargetMenuGrid from "./TargetMenuGrid";
import TargetTypeButton from "./TargetTypeButton";
import HorizontalTargetButton from "./HorizontalTargetButton";
import VerticalTargetButton from "./VerticalTargetButton";
import { CloseIcon, CropIcon, DisplayIcon, InflightLogo, NoCameraIcon, SettingsIcon, WindowIcon } from "~/icons";

const WINDOW_SIZE = { width: 290, height: 442 } as const;

const findCamera = (cameras: CameraInfo[], id: DeviceOrModelID) => {
	return cameras.find((c) => {
		if (!id) return false;
		return "DeviceID" in id ? id.DeviceID === c.device_id : id.ModelID === c.model_id;
	});
};

type WindowListItem = Pick<CaptureWindow, "id" | "owner_name" | "name" | "bounds" | "refresh_rate">;

const createWindowSignature = (list?: readonly WindowListItem[]): string | undefined => {
	if (!list) return undefined;

	return list
		.map((item) => {
			const { position, size } = item.bounds;
			return [
				item.id,
				item.owner_name,
				item.name,
				position.x,
				position.y,
				size.width,
				size.height,
				item.refresh_rate,
			].join(":");
		})
		.join("|");
};

type DisplayListItem = Pick<CaptureDisplay, "id" | "name" | "refresh_rate">;

const createDisplaySignature = (list?: readonly DisplayListItem[]): string | undefined => {
	if (!list) return undefined;

	return list.map((item) => [item.id, item.name, item.refresh_rate].join(":")).join("|");
};

type TargetMenuPanelProps =
	| {
			variant: "display";
			targets?: CaptureDisplayWithThumbnail[];
			onSelect: (target: CaptureDisplayWithThumbnail) => void;
	  }
	| {
			variant: "window";
			targets?: CaptureWindowWithThumbnail[];
			onSelect: (target: CaptureWindowWithThumbnail) => void;
	  }
	| {
			variant: "recording";
			targets?: RecordingWithPath[];
			onSelect: (target: RecordingWithPath) => void;
			onViewAll: () => void;
			uploadProgress?: Record<string, number>;
			reuploadingPaths?: Set<string>;
			onReupload?: (path: string) => void;
			onRefetch?: () => void;
	  }
	| {
			variant: "screenshot";
			targets?: ScreenshotWithPath[];
			onSelect: (target: ScreenshotWithPath) => void;
			onViewAll: () => void;
	  };

type SharedTargetMenuProps = {
	isLoading: boolean;
	errorMessage?: string;
	disabled: boolean;
	onBack: () => void;
};

function TargetMenuPanel(props: TargetMenuPanelProps & SharedTargetMenuProps) {
	const [search, setSearch] = createSignal("");
	const trimmedSearch = createMemo(() => search().trim());
	const normalizedQuery = createMemo(() => trimmedSearch().toLowerCase());
	const placeholder =
		props.variant === "display"
			? "Search displays"
			: props.variant === "window"
			? "Search windows"
			: props.variant === "recording"
			? "Search recordings"
			: "Search screenshots";
	const noResultsMessage =
		props.variant === "display"
			? "No matching displays"
			: props.variant === "window"
			? "No matching windows"
			: props.variant === "recording"
			? "No matching recordings"
			: "No matching screenshots";

	const filteredDisplayTargets = createMemo<CaptureDisplayWithThumbnail[]>(() => {
		if (props.variant !== "display") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;

		const matchesQuery = (value?: string | null) => !!value && value.toLowerCase().includes(query);

		return targets.filter((target) => matchesQuery(target.name) || matchesQuery(target.id));
	});

	const filteredWindowTargets = createMemo<CaptureWindowWithThumbnail[]>(() => {
		if (props.variant !== "window") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;

		const matchesQuery = (value?: string | null) => !!value && value.toLowerCase().includes(query);

		return targets.filter(
			(target) => matchesQuery(target.name) || matchesQuery(target.owner_name) || matchesQuery(target.id)
		);
	});

	const filteredRecordingTargets = createMemo<RecordingWithPath[]>(() => {
		if (props.variant !== "recording") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;

		const matchesQuery = (value?: string | null) => !!value && value.toLowerCase().includes(query);

		return targets.filter((target) => matchesQuery(target.pretty_name));
	});

	const filteredScreenshotTargets = createMemo<ScreenshotWithPath[]>(() => {
		if (props.variant !== "screenshot") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;

		const matchesQuery = (value?: string | null) => !!value && value.toLowerCase().includes(query);

		return targets.filter((target) => matchesQuery(target.pretty_name));
	});

	return (
		<div class="flex flex-col w-full h-full min-h-0">
			<div class="flex gap-3 justify-between items-center mt-3">
				<div
					onClick={() => props.onBack()}
					class="flex gap-1 items-center rounded-md px-1.5 text-xs
					text-gray-11 transition-opacity hover:opacity-70 hover:text-gray-12
					focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1"
				>
					<IconLucideArrowLeft class="size-3 text-gray-11" />
					<span class="font-medium text-gray-12">Back</span>
				</div>
				<div class="relative flex-1 min-w-0 h-[36px] flex items-center">
					<IconLucideSearch class="absolute left-2 top-[48%] -translate-y-1/2 pointer-events-none size-3 text-gray-10" />
					<Input
						type="search"
						class="py-2 pl-6 h-full"
						value={search()}
						onInput={(event) => setSearch(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && search()) {
								event.preventDefault();
								setSearch("");
							}
						}}
						placeholder={placeholder}
						autoCapitalize="off"
						autocorrect="off"
						autocomplete="off"
						spellcheck={false}
						aria-label={placeholder}
					/>
				</div>
			</div>
			<div class="pt-4">
				<div class="px-2 custom-scroll" style="max-height: calc(256px - 100px - 1rem)">
					{props.variant === "display" ? (
						<TargetMenuGrid
							variant="display"
							targets={filteredDisplayTargets()}
							isLoading={props.isLoading}
							errorMessage={props.errorMessage}
							onSelect={props.onSelect}
							disabled={props.disabled}
							highlightQuery={trimmedSearch()}
							emptyMessage={trimmedSearch() ? noResultsMessage : undefined}
						/>
					) : props.variant === "window" ? (
						<TargetMenuGrid
							variant="window"
							targets={filteredWindowTargets()}
							isLoading={props.isLoading}
							errorMessage={props.errorMessage}
							onSelect={props.onSelect}
							disabled={props.disabled}
							highlightQuery={trimmedSearch()}
							emptyMessage={trimmedSearch() ? noResultsMessage : undefined}
						/>
					) : props.variant === "recording" ? (
						<TargetMenuGrid
							variant="recording"
							targets={filteredRecordingTargets()}
							isLoading={props.isLoading}
							errorMessage={props.errorMessage}
							onSelect={props.onSelect}
							disabled={props.disabled}
							highlightQuery={trimmedSearch()}
							emptyMessage={trimmedSearch() ? noResultsMessage : undefined}
							uploadProgress={props.uploadProgress}
							reuploadingPaths={props.reuploadingPaths}
							onReupload={props.onReupload}
							onRefetch={props.onRefetch}
							onViewAll={props.onViewAll}
						/>
					) : (
						<TargetMenuGrid
							variant="screenshot"
							targets={filteredScreenshotTargets()}
							isLoading={props.isLoading}
							errorMessage={props.errorMessage}
							onSelect={props.onSelect}
							disabled={props.disabled}
							highlightQuery={trimmedSearch()}
							emptyMessage={trimmedSearch() ? noResultsMessage : undefined}
							onViewAll={props.onViewAll}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

export default function () {
	const generalSettings = generalSettingsStore.createQuery();

	const navigate = useNavigate();
	createEventListener(window, "focus", () => {
		if (generalSettings.data?.enableNewRecordingFlow === false) navigate("/");
	});

	return (
		<RecordingOptionsProvider>
			<Page />
		</RecordingOptionsProvider>
	);
}

let hasChecked = false;
function createUpdateCheck() {
	if (import.meta.env.DEV) return;

	const navigate = useNavigate();

	onMount(async () => {
		if (hasChecked) return;
		hasChecked = true;

		await new Promise((res) => setTimeout(res, 1000));

		const update = await updater.check();
		if (!update) return;

		const shouldUpdate = await dialog.confirm(
			`Version ${update.version} of Cap is available, would you like to install it?`,
			{ title: "Update Cap", okLabel: "Update", cancelLabel: "Ignore" }
		);

		if (!shouldUpdate) return;
		navigate("/update");
	});
}

function CameraPreview(props: { selectedCamera: CameraInfo | undefined }) {
	const [latestFrame, setLatestFrame] = createSignal<ImageData | null>(null);
	let canvasRef: HTMLCanvasElement | undefined;

	const cameraWsPort = window.__CAP__?.cameraWsPort;

	let ws: WebSocket | undefined;

	const createSocket = () => {
		const socket = new WebSocket(`ws://localhost:${cameraWsPort}`);
		socket.binaryType = "arraybuffer";

		socket.addEventListener("open", () => {
			console.log("Camera preview WebSocket connected");
		});

		socket.addEventListener("close", () => {
			console.log("Camera preview WebSocket disconnected");
		});

		socket.addEventListener("error", (error) => {
			console.error("Camera preview WebSocket error:", error);
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

			if (strideBytes === 0 || strideBytes < expectedRowBytes || source.length < availableLength) {
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
					pixels.set(source.subarray(srcStart, srcStart + expectedRowBytes), destStart);
				}
			}

			const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
			setLatestFrame(imageData);

			const ctx = canvasRef?.getContext("2d");
			ctx?.putImageData(imageData, 0, 0);
		};

		return socket;
	};

	onMount(() => {
		ws = createSocket();

		const reconnectInterval = setInterval(() => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				console.log("Attempting to reconnect camera preview...");
				if (ws) ws.close();
				ws = createSocket();
			}
		}, 5000);

		onCleanup(() => {
			clearInterval(reconnectInterval);
			ws?.close();
		});
	});

	return (
		<div class="relative w-full aspect-video bg-neutral-900 overflow-hidden rounded-t-[20px]">
			<Show
				when={props.selectedCamera}
				// fallback={<div class="flex items-center justify-center h-full text-xs text-gray-11">No camera selected</div>}
				fallback={
					<div class="flex items-center justify-center h-full">
						<div class="flex items-center justify-center size-12 rounded-full bg-white/10">
							<NoCameraIcon class="text-white size-8 mt-0.5" />
						</div>
					</div>
				}
			>
				<Show
					when={latestFrame()}
					fallback={
						<div class="flex items-center justify-center h-full text-xs text-gray-11">
							{cameraWsPort ? "Loading camera..." : "Camera preview unavailable"}
						</div>
					}
				>
					<canvas
						ref={canvasRef!}
						class="w-full h-full object-cover"
						style={{ transform: "scaleX(-1)" }}
						width={latestFrame()?.width}
						height={latestFrame()?.height}
					/>
				</Show>
			</Show>
			<div
				class="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
				style={{
					background: "linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.8))",
				}}
			/>
		</div>
	);
}

function Page() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createCurrentRecordingQuery();
	const isRecording = () => !!currentRecording.data;
	const auth = authStore.createQuery();

	const [hasHiddenMainWindowForPicker, setHasHiddenMainWindowForPicker] = createSignal(false);
	createEffect(() => {
		const pickerActive = rawOptions.targetMode != null;
		const hasHidden = hasHiddenMainWindowForPicker();
		if (pickerActive && !hasHidden) {
			setHasHiddenMainWindowForPicker(true);
			void getCurrentWindow().hide();
		} else if (!pickerActive && hasHidden) {
			setHasHiddenMainWindowForPicker(false);
			const currentWindow = getCurrentWindow();
			void currentWindow.show();
			void currentWindow.setFocus();
		}
	});
	onCleanup(() => {
		if (!hasHiddenMainWindowForPicker()) return;
		setHasHiddenMainWindowForPicker(false);
		void getCurrentWindow().show();
	});

	const [displayMenuOpen, setDisplayMenuOpen] = createSignal(false);
	const [windowMenuOpen, setWindowMenuOpen] = createSignal(false);
	const [recordingsMenuOpen, setRecordingsMenuOpen] = createSignal(false);
	const [screenshotsMenuOpen, setScreenshotsMenuOpen] = createSignal(false);
	const activeMenu = createMemo<"display" | "window" | "recording" | "screenshot" | null>(() => {
		if (displayMenuOpen()) return "display";
		if (windowMenuOpen()) return "window";
		if (recordingsMenuOpen()) return "recording";
		if (screenshotsMenuOpen()) return "screenshot";
		return null;
	});
	const [hasOpenedDisplayMenu, setHasOpenedDisplayMenu] = createSignal(false);
	const [hasOpenedWindowMenu, setHasOpenedWindowMenu] = createSignal(false);

	let displayTriggerRef: HTMLButtonElement | undefined;
	let windowTriggerRef: HTMLButtonElement | undefined;

	const displayTargets = useQuery(() => ({
		...listDisplaysWithThumbnails,
		refetchInterval: false,
	}));

	const windowTargets = useQuery(() => ({
		...listWindowsWithThumbnails,
		refetchInterval: false,
	}));

	const recordings = useQuery(() => listRecordings);

	const [uploadProgress, setUploadProgress] = createStore<Record<string, number>>({});
	const [reuploadingPaths, setReuploadingPaths] = createSignal<Set<string>>(new Set());

	createTauriEventListener(events.uploadProgressEvent, (e) => {
		if (e.uploaded === e.total) {
			setUploadProgress(
				produce((s) => {
					delete s[e.video_id];
				})
			);
		} else {
			const total = Number(e.total);
			const progress = total > 0 ? (Number(e.uploaded) / total) * 100 : 0;
			setUploadProgress(e.video_id, progress);
		}
	});

	createTauriEventListener(events.recordingDeleted, () => recordings.refetch());

	const handleReupload = async (path: string) => {
		setReuploadingPaths((prev) => new Set([...prev, path]));
		try {
			await commands.uploadExportedVideo(path, "Reupload", new Channel<UploadProgress>(() => {}), null, null);
		} finally {
			setReuploadingPaths((prev) => {
				const next = new Set(prev);
				next.delete(path);
				return next;
			});
			recordings.refetch();
		}
	};

	const screenshots = useQuery(() =>
		queryOptions<ScreenshotWithPath[]>({
			queryKey: ["screenshots"],
			queryFn: async () => {
				const result = await commands.listScreenshots().catch(() => [] as const);

				return result.map(([path, meta]) => ({ ...meta, path } as ScreenshotWithPath));
			},
			refetchInterval: 2000,
			reconcile: (old, next) => reconcile(next)(old),
			initialData: [],
		})
	);

	const screens = useQuery(() => listScreens);
	const windows = useQuery(() => listWindows);

	const hasDisplayTargetsData = () => displayTargets.status === "success";
	const hasWindowTargetsData = () => windowTargets.status === "success";

	const existingDisplayIds = createMemo(() => {
		const currentScreens = screens.data;
		if (!currentScreens) return undefined;
		return new Set(currentScreens.map((screen) => screen.id));
	});

	const displayTargetsData = createMemo(() => {
		if (!hasDisplayTargetsData()) return undefined;
		const ids = existingDisplayIds();
		if (!ids) return displayTargets.data;
		return displayTargets.data?.filter((target) => ids.has(target.id));
	});

	const existingWindowIds = createMemo(() => {
		const currentWindows = windows.data;
		if (!currentWindows) return undefined;
		return new Set(currentWindows.map((win) => win.id));
	});

	const windowTargetsData = createMemo(() => {
		if (!hasWindowTargetsData()) return undefined;
		const ids = existingWindowIds();
		if (!ids) return windowTargets.data;
		return windowTargets.data?.filter((target) => ids.has(target.id));
	});

	const recordingsData = createMemo(() => {
		const data = recordings.data;
		if (!data) return [];
		// The Rust backend sorts files descending by creation time (newest first).
		// See list_recordings in apps/desktop/src-tauri/src/lib.rs
		// b_time.cmp(&a_time) ensures newest first.
		// So we just need to take the top 20.
		return data.slice(0, 20).map(([path, meta]) => ({ ...meta, path } as RecordingWithPath));
	});

	const screenshotsData = createMemo(() => {
		const data = screenshots.data;
		if (!data) return [];
		return data.slice(0, 20) as ScreenshotWithPath[];
	});

	const displayMenuLoading = () =>
		!hasDisplayTargetsData() && (displayTargets.status === "pending" || displayTargets.fetchStatus === "fetching");
	const windowMenuLoading = () =>
		!hasWindowTargetsData() && (windowTargets.status === "pending" || windowTargets.fetchStatus === "fetching");

	const displayErrorMessage = () => {
		if (!displayTargets.error) return undefined;
		return "Unable to load displays. Try using the Display button.";
	};

	const windowErrorMessage = () => {
		if (!windowTargets.error) return undefined;
		return "Unable to load windows. Try using the Window button.";
	};

	const selectDisplayTarget = (target: CaptureDisplayWithThumbnail) => {
		setOptions("captureTarget", reconcile({ variant: "display", id: target.id }));
		setOptions("targetMode", "display");
		commands.openTargetSelectOverlays({ variant: "display", id: target.id });
		setDisplayMenuOpen(false);
		displayTriggerRef?.focus();
	};

	const selectWindowTarget = async (target: CaptureWindowWithThumbnail) => {
		setOptions("captureTarget", reconcile({ variant: "window", id: target.id }));
		setOptions("targetMode", "window");
		commands.openTargetSelectOverlays({ variant: "window", id: target.id });
		setWindowMenuOpen(false);
		windowTriggerRef?.focus();

		try {
			await commands.focusWindow(target.id);
		} catch (error) {
			console.error("Failed to focus window:", error);
		}
	};

	createEffect(() => {
		if (!isRecording()) return;
		setDisplayMenuOpen(false);
		setWindowMenuOpen(false);
		setRecordingsMenuOpen(false);
		setScreenshotsMenuOpen(false);
	});

	createUpdateCheck();

	onMount(async () => {
		const { __CAP__ } = window as typeof window & {
			__CAP__?: { initialTargetMode?: RecordingTargetMode | null };
		};
		const targetMode = __CAP__?.initialTargetMode ?? null;
		setOptions({ targetMode });
		if (targetMode) await commands.openTargetSelectOverlays(null);
		else await commands.closeTargetSelectOverlays();

		const currentWindow = getCurrentWindow();

		currentWindow.setSize(new LogicalSize(WINDOW_SIZE.width, WINDOW_SIZE.height));

		const unlistenFocus = currentWindow.onFocusChanged(({ payload: focused }) => {
			if (focused) {
				currentWindow.setSize(new LogicalSize(WINDOW_SIZE.width, WINDOW_SIZE.height));
			}
		});

		const unlistenResize = currentWindow.onResized(() => {
			currentWindow.setSize(new LogicalSize(WINDOW_SIZE.width, WINDOW_SIZE.height));
		});

		commands.updateAuthPlan();

		onCleanup(async () => {
			(await unlistenFocus)?.();
			(await unlistenResize)?.();
		});
	});

	const cameras = useQuery(() => listVideoDevices);
	const mics = useQuery(() => listAudioDevices);

	const windowListSignature = createMemo(() => createWindowSignature(windows.data));
	const displayListSignature = createMemo(() => createDisplaySignature(screens.data));
	const [windowThumbnailsSignature, setWindowThumbnailsSignature] = createSignal<string | undefined>();
	const [displayThumbnailsSignature, setDisplayThumbnailsSignature] = createSignal<string | undefined>();

	createEffect(() => {
		if (windowTargets.status !== "success") return;
		const signature = createWindowSignature(windowTargets.data);
		if (signature !== undefined) setWindowThumbnailsSignature(signature);
	});

	createEffect(() => {
		if (displayTargets.status !== "success") return;
		const signature = createDisplaySignature(displayTargets.data);
		if (signature !== undefined) setDisplayThumbnailsSignature(signature);
	});

	// Refetch thumbnails only when the cheaper lists detect a change.
	createEffect(() => {
		if (!hasOpenedWindowMenu()) return;
		const signature = windowListSignature();
		if (signature === undefined) return;
		if (windowTargets.fetchStatus !== "idle") return;
		if (windowThumbnailsSignature() === signature) return;
		void windowTargets.refetch();
	});

	createEffect(() => {
		if (!hasOpenedDisplayMenu()) return;
		const signature = displayListSignature();
		if (signature === undefined) return;
		if (displayTargets.fetchStatus !== "idle") return;
		if (displayThumbnailsSignature() === signature) return;
		void displayTargets.refetch();
	});

	cameras.promise.then((cameras) => {
		if (rawOptions.cameraID && findCamera(cameras, rawOptions.cameraID)) {
			setOptions("cameraLabel", null);
		}
	});

	mics.promise.then((mics) => {
		if (rawOptions.micName && !mics.includes(rawOptions.micName)) {
			setOptions("micName", null);
		}
	});

	const options = {
		screen: () => {
			let screen: CaptureDisplay | undefined;

			if (rawOptions.captureTarget.variant === "display") {
				const screenId = rawOptions.captureTarget.id;
				screen = screens.data?.find((s) => s.id === screenId) ?? screens.data?.[0];
			} else if (rawOptions.captureTarget.variant === "area") {
				const screenId = rawOptions.captureTarget.screen;
				screen = screens.data?.find((s) => s.id === screenId) ?? screens.data?.[0];
			}

			return screen;
		},
		window: () => {
			let win: CaptureWindow | undefined;

			if (rawOptions.captureTarget.variant === "window") {
				const windowId = rawOptions.captureTarget.id;
				win = windows.data?.find((s) => s.id === windowId) ?? windows.data?.[0];
			}

			return win;
		},
		camera: () => {
			if (!rawOptions.cameraID) return undefined;
			return findCamera(cameras.data || [], rawOptions.cameraID);
		},
		micName: () => mics.data?.find((name) => name === rawOptions.micName),
		target: (): ScreenCaptureTarget | undefined => {
			switch (rawOptions.captureTarget.variant) {
				case "display": {
					const screen = options.screen();
					if (!screen) return;
					return { variant: "display", id: screen.id };
				}
				case "window": {
					const window = options.window();
					if (!window) return;
					return { variant: "window", id: window.id };
				}
				case "area": {
					const screen = options.screen();
					if (!screen) return;
					return {
						variant: "area",
						bounds: rawOptions.captureTarget.bounds,
						screen: screen.id,
					};
				}
			}
		},
	};

	const toggleTargetMode = (mode: "display" | "window" | "area") => {
		if (isRecording()) return;
		const nextMode = rawOptions.targetMode === mode ? null : mode;
		setOptions("targetMode", nextMode);
		if (nextMode) commands.openTargetSelectOverlays(null);
		else commands.closeTargetSelectOverlays();
	};

	createEffect(() => {
		const target = options.target();
		if (!target) return;
		const screen = options.screen();
		if (!screen) return;

		if (target.variant === "window" && windows.data?.length === 0) {
			setOptions("captureTarget", reconcile({ variant: "display", id: screen.id }));
		}
	});

	const setMicInput = createMutation(() => ({
		mutationFn: async (name: string | null) => {
			await commands.setMicInput(name);
			setOptions("micName", name);
		},
	}));

	const setCamera = createCameraMutation();

	onMount(() => {
		if (rawOptions.micName) {
			setMicInput.mutateAsync(rawOptions.micName).catch((error) => console.error("Failed to set mic input:", error));
		}

		if (rawOptions.cameraID && "ModelID" in rawOptions.cameraID)
			setCamera.mutate({ ModelID: rawOptions.cameraID.ModelID });
		else if (rawOptions.cameraID && "DeviceID" in rawOptions.cameraID)
			setCamera.mutate({ DeviceID: rawOptions.cameraID.DeviceID });
		else setCamera.mutate(null);
	});

	const license = createLicenseQuery();

	const signIn = createSignInMutation();

	const BaseControls = () => (
		<div class="flex flex-col">
			<div class="relative">
				<CameraPreview selectedCamera={options.camera()} />
				<div data-tauri-drag-region class="absolute inset-0 z-[5]" />
				<div class="absolute top-2.5 left-2 right-2 flex items-center justify-between pointer-events-none z-10">
					<button
						type="button"
						onClick={async () => {
							getCurrentWindow().close();
						}}
						class="flex items-center justify-center size-6 bg-black/20 hover:bg-black/30 rounded-[8px] backdrop-blur-sm pointer-events-auto"
					>
						<CloseIcon class="text-white size-4" />
					</button>
					<InflightLogo class="text-white" />
					{import.meta.env.DEV && (
						<button
							type="button"
							onClick={() => {
								new WebviewWindow("debug", { url: "/debug" });
							}}
							class="flex justify-center items-center pointer-events-auto"
						>
							<IconLucideBug class="transition-colors text-gray-11 size-4 hover:text-gray-12" />
						</button>
					)}
					<button
						type="button"
						onClick={async () => {
							await commands.showWindow({ Settings: { page: "general" } });
							getCurrentWindow().hide();
						}}
						class="flex items-center justify-center size-6 bg-black/20 hover:bg-black/30 rounded-[8px] backdrop-blur-sm pointer-events-auto"
					>
						<SettingsIcon class="text-white size-4" />
					</button>
				</div>
			</div>
			<div class="p-[2px] -mt-5 relative z-[6]">
				<div
					class="flex flex-col gap-4 p-4 bg-neutral-900 rounded-[16px] border border-white/10 backdrop-blur-sm"
					data-tauri-drag-region
				>
					<p class="text-xs text-white/70 leading-none pointer-events-none">Select inputs</p>
					<div class="space-y-0 border border-white/10 border-dashed rounded-[12px] p-1">
						<CameraSelect
							disabled={cameras.isPending}
							options={cameras.data ?? []}
							value={options.camera() ?? null}
							onChange={(c) => {
								if (!c) setCamera.mutate(null);
								else if (c.model_id) setCamera.mutate({ ModelID: c.model_id });
								else setCamera.mutate({ DeviceID: c.device_id });
							}}
						/>
						<MicrophoneSelect
							disabled={mics.isPending}
							options={mics.isPending ? [] : mics.data ?? []}
							value={mics.isPending ? rawOptions.micName : options.micName() ?? null}
							onChange={(v) => setMicInput.mutate(v)}
						/>
						<SystemAudio />
					</div>
					<p class="text-xs text-white/70 leading-none pointer-events-none">Select what to record</p>
					<div class="flex flex-row gap-1 w-full">
						<VerticalTargetButton
							selected={rawOptions.targetMode === "display"}
							Component={DisplayIcon}
							disabled={isRecording()}
							onClick={() => {
								if (isRecording()) return;
								setOptions("targetMode", (v) => (v === "display" ? null : "display"));
								if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
								else commands.closeTargetSelectOverlays();
							}}
							name="Display"
						/>
						<VerticalTargetButton
							selected={rawOptions.targetMode === "window"}
							Component={WindowIcon}
							disabled={isRecording()}
							onClick={() => {
								if (isRecording()) return;
								setOptions("targetMode", (v) => (v === "window" ? null : "window"));
								if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
								else commands.closeTargetSelectOverlays();
							}}
							name="Window"
						/>
						<VerticalTargetButton
							selected={rawOptions.targetMode === "area"}
							Component={CropIcon}
							disabled={isRecording()}
							onClick={() => {
								if (isRecording()) return;
								setOptions("targetMode", (v) => (v === "area" ? null : "area"));
								if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
								else commands.closeTargetSelectOverlays();
							}}
							name="Area"
						/>
					</div>
				</div>
			</div>
		</div>
	);

	const RecordingControls = () => (
		<div class="flex flex-col gap-4 px-4 pb-4">
			<p class="text-xs text-white/70 leading-none">Select what to record</p>
			<div class="flex flex-col gap-2 w-full">
				<HorizontalTargetButton
					selected={rawOptions.targetMode === "display"}
					Component={DisplayIcon}
					disabled={isRecording()}
					onClick={() => {
						if (isRecording()) return;
						setOptions("targetMode", (v) => (v === "display" ? null : "display"));
						if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
						else commands.closeTargetSelectOverlays();
					}}
					name="Display"
				/>
				<HorizontalTargetButton
					selected={rawOptions.targetMode === "window"}
					Component={WindowIcon}
					disabled={isRecording()}
					onClick={() => {
						if (isRecording()) return;
						setOptions("targetMode", (v) => (v === "window" ? null : "window"));
						if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
						else commands.closeTargetSelectOverlays();
					}}
					name="Window"
				/>
				<HorizontalTargetButton
					selected={rawOptions.targetMode === "area"}
					Component={CropIcon}
					disabled={isRecording()}
					onClick={() => {
						if (isRecording()) return;
						setOptions("targetMode", (v) => (v === "area" ? null : "area"));
						if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
						else commands.closeTargetSelectOverlays();
					}}
					name="Area"
				/>
			</div>
		</div>
	);

	const TargetSelectionHome = () => (
		<Transition
			appear
			enterActiveClass="transition-transform duration-200"
			enterClass="scale-95"
			enterToClass="scale-100"
			exitActiveClass="transition-transform duration-200"
			exitClass="scale-100"
			exitToClass="scale-95"
		>
			<div class="flex flex-col w-full h-full">
				<BaseControls />
			</div>
		</Transition>
	);

	const startSignInCleanup = listen("start-sign-in", async () => {
		const abort = new AbortController();
		for (const win of await getAllWebviewWindows()) {
			if (win.label.startsWith("target-select-overlay")) {
				await win.hide();
			}
		}

		await signIn.mutateAsync(abort).catch(() => {});

		for (const win of await getAllWebviewWindows()) {
			if (win.label.startsWith("target-select-overlay")) {
				await win.show();
			}
		}
	});
	onCleanup(() => startSignInCleanup.then((cb) => cb()));

	return (
		<div
			class={`flex relative ${
				displayMenuOpen() || windowMenuOpen() ? "" : "justify-center"
			} flex-col h-full text-[--text-primary]`}
			data-tauri-drag-region
		>
			<div class="flex-1 min-h-0 w-full flex flex-col">
				<Show when={signIn.isPending}>
					<div class="flex absolute inset-0 justify-center items-center bg-gray-1 animate-in fade-in">
						<div class="flex flex-col gap-4 justify-center items-center">
							<span>Signing In...</span>

							<Button
								onClick={() => {
									signIn.variables?.abort();
									signIn.reset();
								}}
								variant="gray"
								class="w-full"
							>
								Cancel Sign In
							</Button>
						</div>
					</div>
				</Show>
				<Show when={!signIn.isPending}>
					<Show when={activeMenu()} keyed fallback={<TargetSelectionHome />}>
						{(variant) =>
							variant === "display" ? (
								<TargetMenuPanel
									variant="display"
									targets={displayTargetsData()}
									isLoading={displayMenuLoading()}
									errorMessage={displayErrorMessage()}
									onSelect={selectDisplayTarget}
									disabled={isRecording()}
									onBack={() => {
										setDisplayMenuOpen(false);
										displayTriggerRef?.focus();
									}}
								/>
							) : variant === "window" ? (
								<TargetMenuPanel
									variant="window"
									targets={windowTargetsData()}
									isLoading={windowMenuLoading()}
									errorMessage={windowErrorMessage()}
									onSelect={selectWindowTarget}
									disabled={isRecording()}
									onBack={() => {
										setWindowMenuOpen(false);
										windowTriggerRef?.focus();
									}}
								/>
							) : variant === "recording" ? (
								<TargetMenuPanel
									variant="recording"
									targets={recordingsData()}
									isLoading={recordings.isPending}
									errorMessage={recordings.error ? "Failed to load recordings" : undefined}
									onSelect={async (recording) => {
										if (recording.mode === "studio") {
											await commands.showWindow({
												Editor: { project_path: recording.path },
											});
										} else {
											if (recording.sharing?.link) {
												await shell.open(recording.sharing.link);
											}
										}
										getCurrentWindow().hide();
									}}
									disabled={isRecording()}
									onBack={() => {
										setRecordingsMenuOpen(false);
									}}
									onViewAll={async () => {
										await commands.showWindow({
											Settings: { page: "recordings" },
										});
										getCurrentWindow().hide();
									}}
									uploadProgress={uploadProgress}
									reuploadingPaths={reuploadingPaths()}
									onReupload={handleReupload}
									onRefetch={() => recordings.refetch()}
								/>
							) : (
								<TargetMenuPanel
									variant="screenshot"
									targets={screenshotsData()}
									isLoading={screenshots.isPending}
									errorMessage={screenshots.error ? "Failed to load screenshots" : undefined}
									onSelect={async (screenshot) => {
										await commands.showWindow({
											ScreenshotEditor: {
												path: screenshot.path,
											},
										});
										// getCurrentWindow().hide(); // Maybe keep open?
									}}
									disabled={isRecording()}
									onBack={() => {
										setScreenshotsMenuOpen(false);
									}}
									onViewAll={async () => {
										await commands.showWindow({
											Settings: { page: "screenshots" },
										});
										getCurrentWindow().hide();
									}}
								/>
							)
						}
					</Show>
				</Show>
			</div>
		</div>
	);
}
