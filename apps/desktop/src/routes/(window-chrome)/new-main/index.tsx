import { Button } from "@cap/ui-solid";
import { createEventListener } from "@solid-primitives/event-listener";
import { useNavigate } from "@solidjs/router";
import { createMutation, useQuery } from "@tanstack/solid-query";
import { listen } from "@tauri-apps/api/event";
import {
	getAllWebviewWindows,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import {
	getCurrentWindow,
	LogicalSize,
	primaryMonitor,
} from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
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
import { reconcile } from "solid-js/store";
import { Transition } from "solid-transition-group";
import Tooltip from "~/components/Tooltip";
import { generalSettingsStore } from "~/store";
import { createSignInMutation } from "~/utils/auth";
import {
	createCameraMutation,
	createCurrentRecordingQuery,
	createLicenseQuery,
	listAudioDevices,
	listDisplaysWithThumbnails,
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
	type ScreenCaptureTarget,
} from "~/utils/tauri";
import IconLucideAppWindowMac from "~icons/lucide/app-window-mac";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideSearch from "~icons/lucide/search";
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
import SystemAudio from "./SystemAudio";
import TargetDropdownButton from "./TargetDropdownButton";
import TargetMenuGrid from "./TargetMenuGrid";
import TargetTypeButton from "./TargetTypeButton";

function getWindowSize() {
	return {
		width: 270,
		height: 256,
	};
}

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
		props.variant === "display" ? "Search displays" : "Search windows";
	const noResultsMessage =
		props.variant === "display"
			? "No matching displays"
			: "No matching windows";

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

	return (
		<div class="w-full flex flex-col pt-2">
			<div class="flex items-center justify-between gap-2">
				<button
					type="button"
					onClick={() => props.onBack()}
					class="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1"
				>
					<IconLucideArrowLeft class="size-4 text-gray-11" />
					<span class="font-medium text-gray-12">Back</span>
				</button>
				<div class="relative flex-1 min-w-0">
					<IconLucideSearch class="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-gray-10" />
					<input
						type="search"
						value={search()}
						onInput={(event) => setSearch(event.currentTarget.value)}
						placeholder={placeholder}
						autoCapitalize="off"
						autocorrect="off"
						autocomplete="off"
						spellcheck={false}
						aria-label={placeholder}
						onKeyDown={(event) => {
							if (event.key === "Escape" && search()) {
								event.preventDefault();
								setSearch("");
							}
						}}
						class="h-7 w-full rounded-md border border-transparent bg-gray-3 pl-7 pr-2 text-[11px] text-gray-12 placeholder:text-gray-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1"
					/>
				</div>
			</div>
			<div
				class="mt-2 overflow-y-auto scrollbar-none"
				style="max-height: calc(256px - 100px)"
			>
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
				) : (
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
				)}
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
			{ title: "Update Cap", okLabel: "Update", cancelLabel: "Ignore" },
		);

		if (!shouldUpdate) return;
		navigate("/update");
	});
}

function Page() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createCurrentRecordingQuery();
	const isRecording = () => !!currentRecording.data;

	const [displayMenuOpen, setDisplayMenuOpen] = createSignal(false);
	const [windowMenuOpen, setWindowMenuOpen] = createSignal(false);
	const activeMenu = createMemo<"display" | "window" | null>(() => {
		if (displayMenuOpen()) return "display";
		if (windowMenuOpen()) return "window";
		return null;
	});
	const [hasOpenedDisplayMenu, setHasOpenedDisplayMenu] = createSignal(false);
	const [hasOpenedWindowMenu, setHasOpenedWindowMenu] = createSignal(false);

	let displayTriggerRef: HTMLButtonElement | undefined;
	let windowTriggerRef: HTMLButtonElement | undefined;

	const displayTargets = useQuery(() => ({
		...listDisplaysWithThumbnails,
		enabled: hasOpenedDisplayMenu(),
		refetchInterval: false,
	}));

	const windowTargets = useQuery(() => ({
		...listWindowsWithThumbnails,
		enabled: hasOpenedWindowMenu(),
		refetchInterval: false,
	}));

	const hasDisplayTargetsData = () => displayTargets.status === "success";
	const hasWindowTargetsData = () => windowTargets.status === "success";

	const displayTargetsData = createMemo(() =>
		hasDisplayTargetsData() ? displayTargets.data : undefined,
	);

	const windowTargetsData = createMemo(() =>
		hasWindowTargetsData() ? windowTargets.data : undefined,
	);

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

	const selectDisplayTarget = (target: CaptureDisplayWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "display", id: target.id }),
		);
		setOptions("targetMode", "display");
		setDisplayMenuOpen(false);
		displayTriggerRef?.focus();
	};

	const selectWindowTarget = async (target: CaptureWindowWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "window", id: target.id }),
		);
		setOptions("targetMode", "window");
		setWindowMenuOpen(false);
		windowTriggerRef?.focus();

		await commands.focusWindow(target.id);
	};

	createEffect(() => {
		if (!isRecording()) return;
		setDisplayMenuOpen(false);
		setWindowMenuOpen(false);
	});

	createUpdateCheck();

	onMount(async () => {
		setOptions({ targetMode: (window as any).__CAP__.initialTargetMode });

		const currentWindow = getCurrentWindow();

		const size = getWindowSize();
		currentWindow.setSize(new LogicalSize(size.width, size.height));

		const unlistenFocus = currentWindow.onFocusChanged(
			({ payload: focused }) => {
				if (focused) {
					const size = getWindowSize();

					currentWindow.setSize(new LogicalSize(size.width, size.height));
				}
			},
		);

		const unlistenResize = currentWindow.onResized(() => {
			const size = getWindowSize();

			currentWindow.setSize(new LogicalSize(size.width, size.height));
		});

		onCleanup(async () => {
			(await unlistenFocus)?.();
			(await unlistenResize)?.();
		});

		const monitor = await primaryMonitor();
		if (!monitor) return;
	});

	createEffect(() => {
		if (rawOptions.targetMode) commands.openTargetSelectOverlays();
		else commands.closeTargetSelectOverlays();
	});

	const screens = useQuery(() => listScreens);
	const windows = useQuery(() => listWindows);
	const cameras = useQuery(() => listVideoDevices);
	const mics = useQuery(() => listAudioDevices);

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
			let screen;

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
			let win;

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
				options={mics.isPending ? [] : (mics.data ?? [])}
				value={
					mics.isPending ? rawOptions.micName : (options.micName() ?? null)
				}
				onChange={(v) => setMicInput.mutate(v)}
			/>
			<SystemAudio />
		</div>
	);

	const TargetSelectionHome = () => (
		<div class="flex w-full flex-col gap-2">
			<div class="flex w-full flex-row gap-2 items-stretch text-xs text-gray-11">
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
						onClick={() => {
							if (isRecording()) return;
							setOptions("targetMode", (v) =>
								v === "display" ? null : "display",
							);
						}}
						name="Display"
						class="flex-1 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
					/>
					<TargetDropdownButton
						class={cx(
							"rounded-none border-l border-gray-6 focus-visible:ring-0 focus-visible:ring-offset-0",
							displayMenuOpen() && "bg-gray-5",
						)}
						ref={(el) => (displayTriggerRef = el)}
						disabled={isRecording()}
						expanded={displayMenuOpen()}
						onClick={() => {
							setDisplayMenuOpen((prev) => {
								const next = !prev;
								if (next) {
									setWindowMenuOpen(false);
									setHasOpenedDisplayMenu(true);
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
						onClick={() => {
							if (isRecording()) return;
							setOptions("targetMode", (v) =>
								v === "window" ? null : "window",
							);
						}}
						name="Window"
						class="flex-1 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
					/>
					<TargetDropdownButton
						class={cx(
							"rounded-none border-l border-gray-6 focus-visible:ring-0 focus-visible:ring-offset-0",
							windowMenuOpen() && "bg-gray-5",
						)}
						ref={(el) => (windowTriggerRef = el)}
						disabled={isRecording()}
						expanded={windowMenuOpen()}
						onClick={() => {
							setWindowMenuOpen((prev) => {
								const next = !prev;
								if (next) {
									setDisplayMenuOpen(false);
									setHasOpenedWindowMenu(true);
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
					onClick={() => {
						if (isRecording()) return;
						setOptions("targetMode", (v) => (v === "area" ? null : "area"));
					}}
					name="Area"
				/>
			</div>
			<BaseControls />
		</div>
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
			} flex-col px-3 gap-2 h-full text-[--text-primary]`}
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
						<Tooltip content={<span>Previous Recordings</span>}>
							<button
								type="button"
								onClick={async () => {
									await commands.showWindow({
										Settings: { page: "recordings" },
									});
									getCurrentWindow().hide();
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
					<ErrorBoundary fallback={<></>}>
						<Suspense>
							<span
								onClick={async () => {
									if (license.data?.type !== "pro") {
										await commands.showWindow("Upgrade");
									}
								}}
								class={cx(
									"text-[0.6rem] rounded-full px-1.5 py-0.5",
									license.data?.type === "pro"
										? "bg-[--blue-300] text-gray-1 dark:text-gray-12"
										: "bg-gray-4 cursor-pointer hover:bg-gray-5",
									ostype() === "windows" && "ml-2",
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
			</WindowChromeHeader>
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
				<Transition
					appear
					enterActiveClass="animate-in fade-in slide-in-from-top-1 duration-200"
					exitActiveClass="animate-out fade-out slide-out-to-top-1 duration-150"
				>
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
							) : (
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
							)
						}
					</Show>
				</Transition>
			</Show>
		</div>
	);
}
