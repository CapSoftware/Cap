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
	ErrorBoundary,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { reconcile } from "solid-js/store";
import Tooltip from "~/components/Tooltip";
import { generalSettingsStore } from "~/store";
import { createSignInMutation } from "~/utils/auth";
import {
	createCameraMutation,
	createCurrentRecordingQuery,
	createLicenseQuery,
	listAudioDevices,
	listScreens,
	listVideoDevices,
	listWindows,
} from "~/utils/queries";
import {
	type CameraInfo,
	commands,
	type DeviceOrModelID,
	type ScreenCaptureTarget,
} from "~/utils/tauri";
import { WindowChromeHeader } from "../Context";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "../OptionsContext";
import CameraSelect from "./CameraSelect";
import ChangelogButton from "./ChangeLogButton";
import MicrophoneSelect from "./MicrophoneSelect";
import SystemAudio from "./SystemAudio";
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

export default function () {
	const generalSettings = generalSettingsStore.createQuery();

	// We do this on focus so the window doesn't get revealed when toggling the setting
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

	createUpdateCheck();

	onMount(async () => {
		// We don't want the target select overlay on launch
		setOptions({ targetMode: (window as any).__CAP__.initialTargetMode });

		// Enforce window size with multiple safeguards
		const currentWindow = getCurrentWindow();

		// We resize the window on mount as the user could be switching to the new recording flow
		// which has a differently sized window.
		const size = getWindowSize();
		currentWindow.setSize(new LogicalSize(size.width, size.height));

		// Check size when app regains focus
		const unlistenFocus = currentWindow.onFocusChanged(
			({ payload: focused }) => {
				if (focused) {
					const size = getWindowSize();

					currentWindow.setSize(new LogicalSize(size.width, size.height));
				}
			},
		);

		// Listen for resize events
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

	// these options take the raw config values and combine them with the available options,
	// allowing us to define fallbacks if the selected options aren't actually available
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

	// if target is window and no windows are available, switch to screen capture
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
		<div class="flex relative justify-center flex-col px-3 gap-2 h-full text-[--text-primary]">
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
			<div class="flex flex-row gap-2 items-stretch w-full text-xs text-gray-11">
				<TargetTypeButton
					selected={rawOptions.targetMode === "display"}
					Component={IconMdiMonitor}
					disabled={isRecording()}
					onClick={() => {
						//if recording early return
						if (isRecording()) return;
						setOptions("targetMode", (v) =>
							v === "display" ? null : "display",
						);
					}}
					name="Display"
				/>
				<TargetTypeButton
					selected={rawOptions.targetMode === "window"}
					Component={IconLucideAppWindowMac}
					disabled={isRecording()}
					onClick={() => {
						if (isRecording()) return;
						setOptions("targetMode", (v) => (v === "window" ? null : "window"));
					}}
					name="Window"
				/>
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
			<Show when={!signIn.isPending}>
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
						// this prevents options.micName() from suspending on initial load
						value={
							mics.isPending ? rawOptions.micName : (options.micName() ?? null)
						}
						onChange={(v) => setMicInput.mutate(v)}
					/>
					<SystemAudio />
				</div>
			</Show>
		</div>
	);
}
