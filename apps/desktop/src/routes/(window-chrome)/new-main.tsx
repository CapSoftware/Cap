import { useNavigate } from "@solidjs/router";
import {
	createMutation,
	createQuery,
	useQueryClient,
} from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import {
	getCurrentWindow,
	LogicalSize,
	primaryMonitor,
	Window,
} from "@tauri-apps/api/window";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createResource,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import Tooltip from "~/components/Tooltip";
import { trackEvent } from "~/utils/analytics";
import {
	createCameraMutation,
	createCurrentRecordingQuery,
	createLicenseQuery,
	getPermissions,
	listAudioDevices,
	listScreens,
	listVideoDevices,
	listWindows,
} from "~/utils/queries";
import {
	type CameraInfo,
	commands,
	type DeviceOrModelID,
	events,
	type ScreenCaptureTarget,
} from "~/utils/tauri";

function getWindowSize() {
	return {
		width: 270,
		height: 255,
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

function Page() {
	const { rawOptions, setOptions } = useRecordingOptions();

	const license = createLicenseQuery();

	createUpdateCheck();

	onMount(async () => {
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

	const screens = createQuery(() => listScreens);
	const windows = createQuery(() => listWindows);
	const cameras = createQuery(() => listVideoDevices);
	const mics = createQuery(() => listAudioDevices);

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

	return (
		<div class="flex justify-center flex-col p-[0.75rem] gap-[0.75rem] text-[0.875rem] font-[400] h-full text-[--text-primary]">
			<WindowChromeHeader hideMaximize>
				<div
					dir={ostype() === "windows" ? "rtl" : "rtl"}
					class="flex gap-1 items-center mx-2"
				>
					<Tooltip content={<span>Settings</span>}>
						<button
							type="button"
							onClick={async () => {
								await commands.showWindow({ Settings: { page: "general" } });
								getCurrentWindow().hide();
							}}
							class="flex items-center justify-center w-5 h-5 -ml-[1.5px]"
						>
							<IconCapSettings class="text-gray-11 size-5 hover:text-gray-12" />
						</button>
					</Tooltip>
					<Tooltip content={<span>Previous Recordings</span>}>
						<button
							type="button"
							onClick={async () => {
								await commands.showWindow({ Settings: { page: "recordings" } });
								getCurrentWindow().hide();
							}}
							class="flex justify-center items-center w-5 h-5"
						>
							<IconLucideSquarePlay class="text-gray-11 size-5 hover:text-gray-12" />
						</button>
					</Tooltip>

					<ChangelogButton />

					<Show when={!license.isLoading && license.data?.type === "personal"}>
						<button
							type="button"
							onClick={() => commands.showWindow("Upgrade")}
							class="flex relative justify-center items-center w-5 h-5"
						>
							<IconLucideGift class="text-gray-11 size-5 hover:text-gray-12" />
							<div
								style={{ "background-color": "#FF4747" }}
								class="block z-10 absolute top-0 right-0 size-1.5 rounded-full animate-bounce"
							/>
						</button>
					</Show>

					{import.meta.env.DEV && (
						<button
							type="button"
							onClick={() => {
								new WebviewWindow("debug", { url: "/debug" });
							}}
							class="flex justify-center items-center w-5 h-5"
						>
							<IconLucideBug class="text-gray-11 size-5 hover:text-gray-12" />
						</button>
					)}
				</div>
			</WindowChromeHeader>
			<div class="flex flex-row items-stretch gap-1.5 w-full text-xs text-gray-11">
				<TargetTypeButton
					selected={rawOptions.targetMode === "display"}
					Component={IconMdiMonitor}
					onClick={() =>
						setOptions("targetMode", (v) =>
							v === "display" ? null : "display",
						)
					}
					name="Display"
				/>
				<TargetTypeButton
					selected={rawOptions.targetMode === "window"}
					Component={IconLucideAppWindowMac}
					onClick={() =>
						setOptions("targetMode", (v) => (v === "window" ? null : "window"))
					}
					name="Window"
				/>
				<TargetTypeButton
					selected={rawOptions.targetMode === "area"}
					Component={IconMaterialSymbolsScreenshotFrame2Rounded}
					onClick={() =>
						setOptions("targetMode", (v) => (v === "area" ? null : "area"))
					}
					name="Area"
				/>
			</div>
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
	);
}

function useRequestPermission() {
	const queryClient = useQueryClient();

	async function requestPermission(type: "camera" | "microphone") {
		try {
			if (type === "camera") {
				await commands.resetCameraPermissions();
			} else if (type === "microphone") {
				await commands.resetMicrophonePermissions();
			}
			await commands.requestPermission(type);
			await queryClient.refetchQueries(getPermissions);
		} catch (error) {
			console.error(`Failed to get ${type} permission:`, error);
		}
	}

	return requestPermission;
}

import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import * as updater from "@tauri-apps/plugin-updater";
import type { Component } from "solid-js";
import { generalSettingsStore } from "~/store";
import { apiClient } from "~/utils/web-api";
import { WindowChromeHeader } from "./Context";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "./OptionsContext";

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

const NO_CAMERA = "No Camera";

function CameraSelect(props: {
	disabled?: boolean;
	options: CameraInfo[];
	value: CameraInfo | null;
	onChange: (camera: CameraInfo | null) => void;
}) {
	const currentRecording = createCurrentRecordingQuery();
	const permissions = createQuery(() => getPermissions);
	const requestPermission = useRequestPermission();

	const permissionGranted = () =>
		permissions?.data?.camera === "granted" ||
		permissions?.data?.camera === "notNeeded";

	const onChange = (cameraLabel: CameraInfo | null) => {
		if (!cameraLabel && permissions?.data?.camera !== "granted")
			return requestPermission("camera");

		props.onChange(cameraLabel);

		trackEvent("camera_selected", {
			camera_name: cameraLabel?.display_name ?? null,
			enabled: !!cameraLabel,
		});
	};

	return (
		<div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<button
				disabled={!!currentRecording.data || props.disabled}
				class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full disabled:text-gray-11 transition-colors KSelect"
				onClick={() => {
					Promise.all([
						CheckMenuItem.new({
							text: NO_CAMERA,
							checked: props.value === null,
							action: () => onChange(null),
						}),
						PredefinedMenuItem.new({ item: "Separator" }),
						...props.options.map((o) =>
							CheckMenuItem.new({
								text: o.display_name,
								checked: o === props.value,
								action: () => onChange(o),
							}),
						),
					])
						.then((items) => Menu.new({ items }))
						.then((m) => {
							m.popup();
						});
				}}
			>
				<IconCapCamera class="text-gray-11 size-[1.25rem]" />
				<span class="flex-1 text-left truncate">
					{props.value?.display_name ?? NO_CAMERA}
				</span>
				<TargetSelectInfoPill
					value={props.value}
					permissionGranted={permissionGranted()}
					requestPermission={() => requestPermission("camera")}
					onClick={(e) => {
						if (!props.options) return;
						if (props.value !== null) {
							e.stopPropagation();
							props.onChange(null);
						}
					}}
				/>
			</button>
		</div>
	);
}

const NO_MICROPHONE = "No Microphone";

function MicrophoneSelect(props: {
	disabled?: boolean;
	options: string[];
	value: string | null;
	onChange: (micName: string | null) => void;
}) {
	const DB_SCALE = 40;

	const permissions = createQuery(() => getPermissions);
	const currentRecording = createCurrentRecordingQuery();

	const [dbs, setDbs] = createSignal<number | undefined>();
	const [isInitialized, setIsInitialized] = createSignal(false);

	const requestPermission = useRequestPermission();

	const permissionGranted = () =>
		permissions?.data?.microphone === "granted" ||
		permissions?.data?.microphone === "notNeeded";

	type Option = { name: string };

	const handleMicrophoneChange = async (item: Option | null) => {
		if (!props.options) return;
		props.onChange(item ? item.name : null);
		if (!item) setDbs();

		trackEvent("microphone_selected", {
			microphone_name: item?.name ?? null,
			enabled: !!item,
		});
	};

	const result = events.audioInputLevelChange.listen((dbs) => {
		if (!props.value) setDbs();
		else setDbs(dbs.payload);
	});

	onCleanup(() => result.then((unsub) => unsub()));

	// visual audio level from 0 -> 1
	const audioLevel = () =>
		(1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE) ** 0.5;

	// Initialize audio input if needed - only once when component mounts
	onMount(() => {
		if (!props.value || !permissionGranted() || isInitialized()) return;

		setIsInitialized(true);
	});

	return (
		<div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<button
				disabled={!!currentRecording.data || props.disabled}
				class="relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full disabled:text-gray-11 transition-colors KSelect overflow-hidden z-10"
				onClick={() => {
					Promise.all([
						CheckMenuItem.new({
							text: NO_MICROPHONE,
							checked: props.value === null,
							action: () => handleMicrophoneChange(null),
						}),
						PredefinedMenuItem.new({ item: "Separator" }),
						...(props.options ?? []).map((name) =>
							CheckMenuItem.new({
								text: name,
								checked: name === props.value,
								action: () => handleMicrophoneChange({ name: name }),
							}),
						),
					])
						.then((items) => Menu.new({ items }))
						.then((m) => {
							m.popup();
						});
				}}
			>
				<Show when={dbs()}>
					{(_) => (
						<div
							class="bg-blue-100 opacity-50 left-0 inset-y-0 absolute -z-10 transition-[right] duration-100"
							style={{
								right: `${audioLevel() * 100}%`,
							}}
						/>
					)}
				</Show>
				<IconCapMicrophone class="text-gray-11 size-[1.25rem]" />
				<span class="flex-1 text-left truncate">
					{props.value ?? NO_MICROPHONE}
				</span>
				<TargetSelectInfoPill
					value={props.value}
					permissionGranted={permissionGranted()}
					requestPermission={() => requestPermission("microphone")}
					onClick={(e) => {
						if (props.value !== null) {
							e.stopPropagation();
							props.onChange(null);
						}
					}}
				/>
			</button>
		</div>
	);
}

function SystemAudio() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createCurrentRecordingQuery();

	return (
		<button
			onClick={() => {
				if (!rawOptions) return;
				setOptions({ captureSystemAudio: !rawOptions.captureSystemAudio });
			}}
			disabled={!!currentRecording.data}
			class="relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full disabled:text-gray-11 transition-colors KSelect overflow-hidden z-10"
		>
			<div class="size-[1.25rem] flex items-center justify-center">
				<IconPhMonitorBold class="text-gray-11 stroke-2 size-[1.2rem]" />
			</div>
			<span class="flex-1 text-left truncate">
				{rawOptions.captureSystemAudio
					? "Record System Audio"
					: "No System Audio"}
			</span>
			<InfoPill variant={rawOptions.captureSystemAudio ? "blue" : "red"}>
				{rawOptions.captureSystemAudio ? "On" : "Off"}
			</InfoPill>
		</button>
	);
}

function TargetSelectInfoPill<T>(props: {
	value: T | null;
	permissionGranted: boolean;
	requestPermission: () => void;
	onClick: (e: MouseEvent) => void;
}) {
	return (
		<InfoPill
			variant={props.value !== null && props.permissionGranted ? "blue" : "red"}
			onPointerDown={(e) => {
				if (!props.permissionGranted || props.value === null) return;

				e.stopPropagation();
			}}
			onClick={(e) => {
				if (!props.permissionGranted) {
					props.requestPermission();
					return;
				}

				props.onClick(e);
			}}
		>
			{!props.permissionGranted
				? "Request Permission"
				: props.value !== null
					? "On"
					: "Off"}
		</InfoPill>
	);
}

function InfoPill(
	props: ComponentProps<"button"> & { variant: "blue" | "red" },
) {
	return (
		<button
			{...props}
			type="button"
			class={cx(
				"px-[0.375rem] rounded-full text-[0.75rem]",
				props.variant === "blue"
					? "bg-blue-3 text-blue-9"
					: "bg-red-3 text-red-9",
			)}
		/>
	);
}

function ChangelogButton() {
	const [changelogState, setChangelogState] = makePersisted(
		createStore({
			hasUpdate: false,
			lastOpenedVersion: "",
			changelogClicked: false,
		}),
		{ name: "changelogState" },
	);

	const [currentVersion] = createResource(() => getVersion());

	const [changelogStatus] = createResource(
		() => currentVersion(),
		async (version) => {
			if (!version) {
				return { hasUpdate: false };
			}
			const response = await apiClient.desktop.getChangelogStatus({
				query: { version },
			});
			if (response.status === 200) return response.body;
			return null;
		},
	);

	const handleChangelogClick = () => {
		commands.showWindow({ Settings: { page: "changelog" } });
		getCurrentWindow().hide();
		const version = currentVersion();
		if (version) {
			setChangelogState({
				hasUpdate: false,
				lastOpenedVersion: version,
				changelogClicked: true,
			});
		}
	};

	createEffect(() => {
		if (changelogStatus.state === "ready" && currentVersion()) {
			const hasUpdate = changelogStatus()?.hasUpdate || false;
			if (
				hasUpdate === true &&
				changelogState.lastOpenedVersion !== currentVersion()
			) {
				setChangelogState({
					hasUpdate: true,
					lastOpenedVersion: currentVersion(),
					changelogClicked: false,
				});
			}
		}
	});

	return (
		<Tooltip openDelay={0} content="Changelog">
			<button
				type="button"
				onClick={handleChangelogClick}
				class="flex relative justify-center items-center w-5 h-5"
			>
				<IconLucideBell class="text-gray-11 size-5 hover:text-gray-12" />
				{changelogState.hasUpdate && (
					<div
						style={{ "background-color": "#FF4747" }}
						class="block z-10 absolute top-0 right-0 size-1.5 rounded-full animate-bounce"
					/>
				)}
			</button>
		</Tooltip>
	);
}

function TargetTypeButton(
	props: {
		selected: boolean;
		Component: Component<ComponentProps<"svg">>;
		name: string;
	} & ComponentProps<"div">,
) {
	return (
		<div
			{...props}
			class={cx(
				"flex-1 text-center flex flex-col items-center justify-end gap-1 py-1.5 rounded-lg transition-colors duration-100",
				props.selected && "bg-gray-3 text-white",
			)}
		>
			<props.Component class="size-6" />
			<span>{props.name}</span>
		</div>
	);
}
