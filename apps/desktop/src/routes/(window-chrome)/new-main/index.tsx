import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { createMutation, queryOptions, useQuery } from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	getAllWebviewWindows,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import * as shell from "@tauri-apps/plugin-shell";
import * as updater from "@tauri-apps/plugin-updater";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	ErrorBoundary,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { Transition } from "solid-transition-group";
import Mode from "~/components/Mode";
import { RecoveryToast } from "~/components/RecoveryToast";
import Tooltip from "~/components/Tooltip";
import { Input } from "~/routes/editor/ui";
import { authStore } from "~/store";
import { createSignInMutation } from "~/utils/auth";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createDevicesQuery } from "~/utils/devices";
import {
	createCameraMutation,
	createCurrentRecordingQuery,
	createLicenseQuery,
	listDisplaysWithThumbnails,
	listRecordings,
	listScreens,
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
import IconLucideImport from "~icons/lucide/import";
import IconLucideSearch from "~icons/lucide/search";
import IconLucideSquarePlay from "~icons/lucide/square-play";
import IconMaterialSymbolsScreenshotFrame2Rounded from "~icons/material-symbols/screenshot-frame-2-rounded";
import IconMdiMonitor from "~icons/mdi/monitor";
import { WindowChromeHeader } from "../Context";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "../OptionsContext";
import CameraSelect from "./CameraSelect";
import ChangelogButton from "./ChangeLogButton";
import MicrophoneSelect from "./MicrophoneSelect";
import ModeInfoPanel from "./ModeInfoPanel";
import SystemAudio from "./SystemAudio";
import type { RecordingWithPath, ScreenshotWithPath } from "./TargetCard";
import TargetDropdownButton from "./TargetDropdownButton";
import TargetMenuGrid from "./TargetMenuGrid";
import TargetTypeButton from "./TargetTypeButton";

const WINDOW_SIZE = { width: 330, height: 345 } as const;

const findCamera = (cameras: CameraInfo[], id: DeviceOrModelID) => {
	return cameras.find((c) => {
		if (!id) return false;
		return "DeviceID" in id
			? id.DeviceID === c.device_id
			: id.ModelID === c.model_id;
	});
};

type WindowListItem = Pick<
	CaptureWindow,
	"id" | "owner_name" | "name" | "bounds" | "refresh_rate"
>;

const createWindowSignature = (
	list?: readonly WindowListItem[],
): string | undefined => {
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

const createDisplaySignature = (
	list?: readonly DisplayListItem[],
): string | undefined => {
	if (!list) return undefined;

	return list
		.map((item) => [item.id, item.name, item.refresh_rate].join(":"))
		.join("|");
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

	const handleImport = async () => {
		const result = await dialog.open({
			filters: [
				{
					name: "Video Files",
					extensions: ["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"],
				},
			],
			multiple: false,
		});

		if (result) {
			try {
				const projectPath = await commands.startVideoImport(result as string);
				await commands.showWindow({ Editor: { project_path: projectPath } });
				getCurrentWindow().hide();
			} catch (e) {
				console.error("Failed to import video:", e);
				await dialog.message(
					`Failed to import video: ${e instanceof Error ? e.message : String(e)}`,
					{ title: "Import Error", kind: "error" },
				);
			}
		}
	};

	const filteredDisplayTargets = createMemo<CaptureDisplayWithThumbnail[]>(
		() => {
			if (props.variant !== "display") return [];
			const query = normalizedQuery();
			const targets = props.targets ?? [];
			if (!query) return targets;

			const matchesQuery = (value?: string | null) =>
				!!value && value.toLowerCase().includes(query);

			return targets.filter(
				(target) => matchesQuery(target.name) || matchesQuery(target.id),
			);
		},
	);

	const filteredWindowTargets = createMemo<CaptureWindowWithThumbnail[]>(() => {
		if (props.variant !== "window") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;

		const matchesQuery = (value?: string | null) =>
			!!value && value.toLowerCase().includes(query);

		return targets.filter(
			(target) =>
				matchesQuery(target.name) ||
				matchesQuery(target.owner_name) ||
				matchesQuery(target.id),
		);
	});

	const filteredRecordingTargets = createMemo<RecordingWithPath[]>(() => {
		if (props.variant !== "recording") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;

		const matchesQuery = (value?: string | null) =>
			!!value && value.toLowerCase().includes(query);

		return targets.filter((target) => matchesQuery(target.pretty_name));
	});

	const filteredScreenshotTargets = createMemo<ScreenshotWithPath[]>(() => {
		if (props.variant !== "screenshot") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;

		const matchesQuery = (value?: string | null) =>
			!!value && value.toLowerCase().includes(query);

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
				<div class="flex gap-2 flex-1 min-w-0">
					<div class="relative flex-1 min-w-0 h-[36px] flex items-center">
						<IconLucideSearch class="absolute left-2 top-[48%] -translate-y-1/2 pointer-events-none size-3 text-gray-10" />
						<Input
							type="search"
							class="py-2 pl-6 h-full w-full"
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
					<Show when={props.variant === "recording"}>
						<Button
							variant="gray"
							size="sm"
							class="h-[36px] px-3 shrink-0 flex items-center gap-1.5"
							onClick={handleImport}
						>
							<IconLucideImport class="size-3.5" />
							<span>Import</span>
						</Button>
					</Show>
				</div>
			</div>
			<div class="flex flex-col flex-1 min-h-0 pt-4">
				<div class="px-2 custom-scroll flex-1 overflow-y-auto">
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

		let update: updater.Update | undefined;
		try {
			const result = await updater.check();
			if (result) update = result;
		} catch (e) {
			console.error("Failed to check for updates:", e);
			await dialog.message(
				"Unable to check for updates. Please download the latest version manually from cap.so/download. Your data will not be lost.\n\nIf this issue persists, please contact support.",
				{ title: "Update Error", kind: "error" },
			);
			return;
		}

		if (!update) return;

		let shouldUpdate: boolean | undefined;
		try {
			shouldUpdate = await dialog.confirm(
				`Version ${update.version} of Cap is available, would you like to install it?`,
				{ title: "Update Cap", okLabel: "Update", cancelLabel: "Ignore" },
			);
		} catch (e) {
			console.error("Failed to show update dialog:", e);
			return;
		}

		if (!shouldUpdate) return;
		navigate("/update");
	});
}

function Page() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createCurrentRecordingQuery();
	const isRecording = () => !!currentRecording.data;
	const auth = authStore.createQuery();

	const [hasHiddenMainWindowForPicker, setHasHiddenMainWindowForPicker] =
		createSignal(false);
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

	const handleMouseEnter = () => {
		getCurrentWindow().setFocus();
	};

	const [displayMenuOpen, setDisplayMenuOpen] = createSignal(false);
	const [windowMenuOpen, setWindowMenuOpen] = createSignal(false);
	const [recordingsMenuOpen, setRecordingsMenuOpen] = createSignal(false);
	const [screenshotsMenuOpen, setScreenshotsMenuOpen] = createSignal(false);
	const [modeInfoMenuOpen, setModeInfoMenuOpen] = createSignal(false);
	const activeMenu = createMemo<
		"display" | "window" | "recording" | "screenshot" | "modeInfo" | null
	>(() => {
		if (displayMenuOpen()) return "display";
		if (windowMenuOpen()) return "window";
		if (recordingsMenuOpen()) return "recording";
		if (screenshotsMenuOpen()) return "screenshot";
		if (modeInfoMenuOpen()) return "modeInfo";
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

	const [uploadProgress, setUploadProgress] = createStore<
		Record<string, number>
	>({});
	const [reuploadingPaths, setReuploadingPaths] = createSignal<Set<string>>(
		new Set(),
	);

	createTauriEventListener(events.uploadProgressEvent, (e) => {
		if (e.uploaded === e.total) {
			setUploadProgress(
				produce((s) => {
					delete s[e.video_id];
				}),
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
			await commands.uploadExportedVideo(
				path,
				"Reupload",
				new Channel<UploadProgress>(() => {}),
				null,
			);
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
				const result = await commands
					.listScreenshots()
					.catch(() => [] as const);

				return result.map(
					([path, meta]) => ({ ...meta, path }) as ScreenshotWithPath,
				);
			},
			refetchInterval: 10_000,
			staleTime: 5_000,
			reconcile: (old, next) => reconcile(next)(old),
			initialData: [],
			initialDataUpdatedAt: 0,
		}),
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

	const [recordingsStore, setRecordingsStore] = createStore<
		RecordingWithPath[]
	>([]);
	createEffect(() => {
		const data = recordings.data;
		if (!data) {
			setRecordingsStore(reconcile([]));
			return;
		}
		const mapped = data
			.slice(0, 20)
			.map(([path, meta]) => ({ ...meta, path }) as RecordingWithPath);
		setRecordingsStore(reconcile(mapped));
	});
	const recordingsData = () => recordingsStore;

	const [screenshotsStore, setScreenshotsStore] = createStore<
		ScreenshotWithPath[]
	>([]);
	createEffect(() => {
		const data = screenshots.data;
		if (!data) {
			setScreenshotsStore(reconcile([]));
			return;
		}
		setScreenshotsStore(reconcile(data.slice(0, 20)));
	});
	const screenshotsData = () => screenshotsStore;

	const displayMenuLoading = () =>
		!hasDisplayTargetsData() &&
		(displayTargets.status === "pending" ||
			displayTargets.fetchStatus === "fetching");
	const windowMenuLoading = () =>
		!hasWindowTargetsData() &&
		(windowTargets.status === "pending" ||
			windowTargets.fetchStatus === "fetching");

	const displayErrorMessage = () => {
		if (!displayTargets.error) return undefined;
		return "Unable to load displays. Try using the Display button.";
	};

	const windowErrorMessage = () => {
		if (!windowTargets.error) return undefined;
		return "Unable to load windows. Try using the Window button.";
	};

	const selectDisplayTarget = async (target: CaptureDisplayWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "display", id: target.id }),
		);
		setDisplayMenuOpen(false);
		displayTriggerRef?.focus();
		await commands.openTargetSelectOverlays(
			{ variant: "display", id: target.id },
			null,
			"display",
		);
		setOptions("targetMode", "display");
	};

	const selectWindowTarget = async (target: CaptureWindowWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "window", id: target.id }),
		);
		setWindowMenuOpen(false);
		windowTriggerRef?.focus();
		await commands.openTargetSelectOverlays(
			{ variant: "window", id: target.id },
			null,
			"window",
		);
		setOptions("targetMode", "window");

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
		setModeInfoMenuOpen(false);
	});

	createUpdateCheck();

	onMount(async () => {
		const { __CAP__ } = window as typeof window & {
			__CAP__?: { initialTargetMode?: RecordingTargetMode | null };
		};
		const targetMode = __CAP__?.initialTargetMode ?? null;
		if (targetMode) {
			await commands.openTargetSelectOverlays(null, null, targetMode);
			setOptions({ targetMode });
		} else {
			setOptions({ targetMode });
			await commands.closeTargetSelectOverlays();
		}

		const currentWindow = getCurrentWindow();

		currentWindow.setSize(
			new LogicalSize(WINDOW_SIZE.width, WINDOW_SIZE.height),
		);

		const unlistenFocus = currentWindow.onFocusChanged(
			({ payload: focused }) => {
				if (focused) {
					currentWindow.setSize(
						new LogicalSize(WINDOW_SIZE.width, WINDOW_SIZE.height),
					);
				}
			},
		);

		const unlistenResize = currentWindow.onResized(() => {
			currentWindow.setSize(
				new LogicalSize(WINDOW_SIZE.width, WINDOW_SIZE.height),
			);
		});

		const unlistenSetTargetMode = events.requestSetTargetMode.listen(
			async (event) => {
				const newTargetMode = event.payload.target_mode;
				const displayId = event.payload.display_id;
				if (newTargetMode) {
					await commands.openTargetSelectOverlays(
						null,
						displayId,
						newTargetMode,
					);
					setOptions({ targetMode: newTargetMode });
				} else {
					setOptions({ targetMode: newTargetMode });
					await commands.closeTargetSelectOverlays();
				}
			},
		);

		commands.updateAuthPlan();

		onCleanup(async () => {
			(await unlistenFocus)?.();
			(await unlistenResize)?.();
			(await unlistenSetTargetMode)?.();
		});
	});

	const devices = createDevicesQuery();
	const cameras = createMemo(() => devices.data?.cameras ?? []);
	const mics = createMemo(() => devices.data?.microphones ?? []);
	const permissions = createMemo(() => devices.data?.permissions);

	const windowListSignature = createMemo(() =>
		createWindowSignature(windows.data),
	);
	const displayListSignature = createMemo(() =>
		createDisplaySignature(screens.data),
	);
	const [windowThumbnailsSignature, setWindowThumbnailsSignature] =
		createSignal<string | undefined>();
	const [displayThumbnailsSignature, setDisplayThumbnailsSignature] =
		createSignal<string | undefined>();

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

	createEffect(() => {
		const cameraList = cameras();
		if (rawOptions.cameraID && findCamera(cameraList, rawOptions.cameraID)) {
			setOptions("cameraLabel", null);
		}
	});

	createEffect(() => {
		const micList = mics();
		if (rawOptions.micName && !micList.includes(rawOptions.micName)) {
			setOptions("micName", null);
		}
	});

	const options = {
		screen: () => {
			let screen: CaptureDisplay | undefined;

			if (rawOptions.captureTarget.variant === "display") {
				const screenId = rawOptions.captureTarget.id;
				screen =
					screens.data?.find((s) => s.id === screenId) ?? screens.data?.[0];
			} else if (rawOptions.captureTarget.variant === "area") {
				const screenId = rawOptions.captureTarget.screen;
				screen =
					screens.data?.find((s) => s.id === screenId) ?? screens.data?.[0];
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
			return findCamera(cameras(), rawOptions.cameraID);
		},
		micName: () => mics().find((name) => name === rawOptions.micName),
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

	const toggleTargetMode = async (mode: "display" | "window" | "area") => {
		if (isRecording()) return;
		const nextMode = rawOptions.targetMode === mode ? null : mode;
		if (nextMode) {
			await commands.openTargetSelectOverlays(null, null, nextMode);
			setOptions("targetMode", nextMode);
		} else {
			setOptions("targetMode", nextMode);
			await commands.closeTargetSelectOverlays();
		}
	};

	createEffect(() => {
		const target = options.target();
		if (!target) return;
		const screen = options.screen();
		if (!screen) return;

		if (target.variant === "window" && windows.data?.length === 0) {
			setOptions(
				"captureTarget",
				reconcile({ variant: "display", id: screen.id }),
			);
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
			setMicInput
				.mutateAsync(rawOptions.micName)
				.catch((error) => console.error("Failed to set mic input:", error));
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
		<div class="space-y-2">
			<CameraSelect
				disabled={devices.isPending}
				options={cameras()}
				value={options.camera() ?? null}
				onChange={(c) => {
					if (!c) setCamera.mutate(null);
					else if (c.model_id) setCamera.mutate({ ModelID: c.model_id });
					else setCamera.mutate({ DeviceID: c.device_id });
				}}
				permissions={permissions()}
			/>
			<MicrophoneSelect
				disabled={devices.isPending}
				options={mics()}
				value={options.micName() ?? null}
				onChange={(v) => setMicInput.mutate(v)}
				permissions={permissions()}
			/>
			<SystemAudio />
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
			<div class="flex flex-col gap-2 w-full">
				<div class="flex flex-row gap-2 items-stretch w-full text-xs text-gray-11">
					<div
						class={cx(
							"flex flex-1 overflow-hidden rounded-lg bg-gray-3 ring-1 ring-transparent ring-offset-2 ring-offset-gray-1 transition focus-within:ring-blue-9 focus-within:ring-offset-2 focus-within:ring-offset-gray-1",
							(rawOptions.targetMode === "display" || displayMenuOpen()) &&
								"ring-blue-9",
						)}
					>
						<TargetTypeButton
							selected={rawOptions.targetMode === "display"}
							Component={IconMdiMonitor}
							disabled={isRecording()}
							onClick={() => toggleTargetMode("display")}
							name="Display"
							class="flex-1 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
						/>
						<TargetDropdownButton
							class={cx(
								"rounded-none border-l border-gray-6 focus-visible:ring-0 focus-visible:ring-offset-0",
								displayMenuOpen() && "bg-gray-5",
							)}
							ref={displayTriggerRef}
							disabled={isRecording()}
							expanded={displayMenuOpen()}
							onClick={() => {
								setDisplayMenuOpen((prev) => {
									const next = !prev;
									if (next) {
										setWindowMenuOpen(false);
										setHasOpenedDisplayMenu(true);
										screens.refetch();
										displayTargets.refetch();
									}
									return next;
								});
							}}
							aria-haspopup="menu"
							aria-label="Choose display"
						/>
					</div>
					<div
						class={cx(
							"flex flex-1 overflow-hidden rounded-lg bg-gray-3 ring-1 ring-transparent ring-offset-2 ring-offset-gray-1 transition focus-within:ring-blue-9 focus-within:ring-offset-2 focus-within:ring-offset-gray-1",
							(rawOptions.targetMode === "window" || windowMenuOpen()) &&
								"ring-blue-9",
						)}
					>
						<TargetTypeButton
							selected={rawOptions.targetMode === "window"}
							Component={IconLucideAppWindowMac}
							disabled={isRecording()}
							onClick={() => toggleTargetMode("window")}
							name="Window"
							class="flex-1 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
						/>
						<TargetDropdownButton
							class={cx(
								"rounded-none border-l border-gray-6 focus-visible:ring-0 focus-visible:ring-offset-0",
								windowMenuOpen() && "bg-gray-5",
							)}
							ref={windowTriggerRef}
							disabled={isRecording()}
							expanded={windowMenuOpen()}
							onClick={() => {
								setWindowMenuOpen((prev) => {
									const next = !prev;
									if (next) {
										setDisplayMenuOpen(false);
										setHasOpenedWindowMenu(true);
										windows.refetch();
										windowTargets.refetch();
									}
									return next;
								});
							}}
							aria-haspopup="menu"
							aria-label="Choose window"
						/>
					</div>
					<TargetTypeButton
						selected={rawOptions.targetMode === "area"}
						Component={IconMaterialSymbolsScreenshotFrame2Rounded}
						disabled={isRecording()}
						onClick={() => toggleTargetMode("area")}
						name="Area"
					/>
				</div>
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
			onMouseEnter={handleMouseEnter}
			class="flex relative flex-col px-[13px] gap-2 pb-[8px] h-full min-h-0 text-[--text-primary]"
		>
			<WindowChromeHeader hideMaximize>
				<div
					class={cx(
						"flex items-center mx-2 w-full",
						ostype() === "macos" && "flex-row-reverse",
					)}
					data-tauri-drag-region
				>
					<div class="flex gap-1 items-center" data-tauri-drag-region>
						<Tooltip content={<span>Settings</span>}>
							<button
								type="button"
								onClick={async () => {
									await commands.showWindow({ Settings: { page: "general" } });
									getCurrentWindow().hide();
								}}
								class="flex items-center justify-center size-5 -ml-[1.5px]"
							>
								<IconCapSettings class="transition-colors text-gray-11 size-4 hover:text-gray-12" />
							</button>
						</Tooltip>
						<Tooltip content={<span>Screenshots</span>}>
							<button
								type="button"
								onClick={() => {
									setScreenshotsMenuOpen((prev) => {
										const next = !prev;
										if (next) {
											setDisplayMenuOpen(false);
											setWindowMenuOpen(false);
											setRecordingsMenuOpen(false);
										}
										return next;
									});
								}}
								class="flex justify-center items-center size-5"
							>
								<IconLucideImage class="transition-colors text-gray-11 size-4 hover:text-gray-12" />
							</button>
						</Tooltip>
						<Tooltip content={<span>Recordings</span>}>
							<button
								type="button"
								onClick={() => {
									setRecordingsMenuOpen((prev) => {
										const next = !prev;
										if (next) {
											setDisplayMenuOpen(false);
											setWindowMenuOpen(false);
											setScreenshotsMenuOpen(false);
										}
										return next;
									});
								}}
								class="flex justify-center items-center size-5"
							>
								<IconLucideSquarePlay class="transition-colors text-gray-11 size-4 hover:text-gray-12" />
							</button>
						</Tooltip>
						<ChangelogButton />
						{import.meta.env.DEV && (
							<button
								type="button"
								onClick={() => {
									new WebviewWindow("debug", { url: "/debug" });
								}}
								class="flex justify-center items-center"
							>
								<IconLucideBug class="transition-colors text-gray-11 size-4 hover:text-gray-12" />
							</button>
						)}
					</div>
					{ostype() === "macos" && (
						<div class="flex-1" data-tauri-drag-region />
					)}
				</div>
			</WindowChromeHeader>
			<Show when={!activeMenu()}>
				<div class="flex items-center justify-between mt-[18px] mb-[6px]">
					<div class="flex items-center space-x-1">
						<a
							class="*:w-[92px] *:h-auto text-[--text-primary]"
							target="_blank"
							href={
								auth.data
									? `${import.meta.env.VITE_SERVER_URL}/dashboard`
									: import.meta.env.VITE_SERVER_URL
							}
						>
							<IconCapLogoFullDark class="hidden dark:block" />
							<IconCapLogoFull class="block dark:hidden" />
						</a>
						<ErrorBoundary fallback={null}>
							<Suspense>
								<span
									onClick={async () => {
										if (license.data?.type !== "pro") {
											await commands.showWindow("Upgrade");
										}
									}}
									class={cx(
										"text-[0.6rem] ml-2 rounded-lg px-1 py-0.5",
										license.data?.type === "pro"
											? "bg-[--blue-400] text-gray-1 dark:text-gray-12"
											: "bg-gray-3 cursor-pointer hover:bg-gray-5",
									)}
								>
									{license.data?.type === "commercial"
										? "Commercial"
										: license.data?.type === "pro"
											? "Pro"
											: "Personal"}
								</span>
							</Suspense>
						</ErrorBoundary>
					</div>
					<Mode
						onInfoClick={() => {
							setModeInfoMenuOpen(true);
							setDisplayMenuOpen(false);
							setWindowMenuOpen(false);
							setRecordingsMenuOpen(false);
							setScreenshotsMenuOpen(false);
						}}
					/>
				</div>
			</Show>
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
									errorMessage={
										recordings.error ? "Failed to load recordings" : undefined
									}
									onSelect={async (recording) => {
										if (recording.mode === "studio") {
											let projectPath = recording.path;

											const needsRecovery =
												recording.status.status === "InProgress" ||
												recording.status.status === "NeedsRemux";

											if (needsRecovery) {
												try {
													projectPath =
														await commands.recoverRecording(projectPath);
												} catch (e) {
													console.error("Failed to recover recording:", e);
												}
											}

											await commands.showWindow({
												Editor: { project_path: projectPath },
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
							) : variant === "screenshot" ? (
								<TargetMenuPanel
									variant="screenshot"
									targets={screenshotsData()}
									isLoading={screenshots.isPending}
									errorMessage={
										screenshots.error ? "Failed to load screenshots" : undefined
									}
									onSelect={async (screenshot) => {
										await commands.showWindow({
											ScreenshotEditor: {
												path: screenshot.path,
											},
										});
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
							) : (
								<ModeInfoPanel
									onBack={() => {
										setModeInfoMenuOpen(false);
									}}
								/>
							)
						}
					</Show>
				</Show>
			</div>
			<RecoveryToast />
		</div>
	);
}
