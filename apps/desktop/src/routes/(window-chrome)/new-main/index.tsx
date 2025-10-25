import { Button } from "@cap/ui-solid";
import { createEventListener } from "@solid-primitives/event-listener";
import { useNavigate } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
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
// Removed solid-motionone in favor of solid-transition-group
import { Transition } from "solid-transition-group";
import Tooltip from "~/components/Tooltip";
import { Input } from "~/routes/editor/ui";
import { generalSettingsStore } from "~/store";
import { createSignInMutation } from "~/utils/auth";
import {
	createCurrentRecordingQuery,
	createLicenseQuery,
	listDisplaysWithThumbnails,
	listWindowsWithThumbnails,
} from "~/utils/queries";
import {
	type CaptureDisplay,
	type CaptureDisplayWithThumbnail,
	type CaptureWindow,
	type CaptureWindowWithThumbnail,
	commands,
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
import { BaseControls } from "./BaseControls";
import ChangelogButton from "./ChangeLogButton";
import TargetDropdownButton from "./TargetDropdownButton";
import TargetMenuGrid from "./TargetMenuGrid";
import TargetTypeButton from "./TargetTypeButton";
import { useSystemHardwareOptions } from "./useSystemHardwareOptions";

function getWindowSize() {
	return {
		width: 270,
		height: 256,
	};
}

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
		<div class="flex flex-col w-full">
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
				<div
					class="px-2 custom-scroll"
					style="max-height: calc(256px - 100px - 1rem)"
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
		refetchInterval: false,
	}));

	const windowTargets = useQuery(() => ({
		...listWindowsWithThumbnails,
		refetchInterval: false,
	}));

	const { screens, windows, cameras, mics, options } =
		useSystemHardwareOptions();
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
		commands.openTargetSelectOverlays(rawOptions.captureTarget);
		setDisplayMenuOpen(false);
		displayTriggerRef?.focus();
	};

	const selectWindowTarget = async (target: CaptureWindowWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "window", id: target.id }),
		);
		setOptions("targetMode", "window");
		commands.openTargetSelectOverlays(rawOptions.captureTarget);
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
	});

	createUpdateCheck();

	onMount(async () => {
		const targetMode = (window as any).__CAP__.initialTargetMode;
		setOptions({ targetMode });
		if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
		else commands.closeTargetSelectOverlays();

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

	const license = createLicenseQuery();
	const signIn = createSignInMutation();

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
							onClick={() => {
								if (isRecording()) return;
								setOptions("targetMode", (v) =>
									v === "display" ? null : "display",
								);
								if (rawOptions.targetMode)
									commands.openTargetSelectOverlays(null);
								else commands.closeTargetSelectOverlays();
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
								if (rawOptions.targetMode)
									commands.openTargetSelectOverlays(null);
								else commands.closeTargetSelectOverlays();
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
							if (rawOptions.targetMode)
								commands.openTargetSelectOverlays(null);
							else commands.closeTargetSelectOverlays();
						}}
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
									"text-[0.6rem] ml-2 rounded-full px-1.5 py-0.5",
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
			</Show>
		</div>
	);
}
