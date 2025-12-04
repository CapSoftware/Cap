import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { createMutation, createQuery } from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createResource,
	ErrorBoundary,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import Mode from "~/components/Mode";
import Tooltip from "~/components/Tooltip";
import { identifyUser, trackEvent } from "~/utils/analytics";
import {
	createCameraMutation,
	createCurrentRecordingQuery,
	createLicenseQuery,
	createVideoDevicesQuery,
	listAudioDevices,
	listScreens,
	listWindows,
} from "~/utils/queries";
import {
	type CameraInfo,
	type CaptureDisplay,
	type CaptureWindow,
	commands,
	events,
	type RecordingMode,
	type ScreenCaptureTarget,
} from "~/utils/tauri";

function getWindowSize() {
	return {
		width: 300,
		height: 340,
	};
}

export default function () {
	return (
		<RecordingOptionsProvider>
			<Page />
		</RecordingOptionsProvider>
	);
}

function Page() {
	const { rawOptions, setOptions } = useRecordingOptions();

	const currentRecording = createCurrentRecordingQuery();
	const generalSettings = generalSettingsStore.createQuery();

	// We do this on focus so the window doesn't get revealed when toggling the setting
	const navigate = useNavigate();
	createEventListener(window, "focus", () => {
		if (generalSettings.data?.enableNewRecordingFlow === true) navigate("/new-main");
	});

	const isRecording = () => !!currentRecording.data;

	const license = createLicenseQuery();

	createUpdateCheck();

	const auth = authStore.createQuery();

	onMount(async () => {
		const auth = await authStore.get();
		const userId = auth?.user_id;
		if (!userId) return;

		const trackedSession = localStorage.getItem("tracked_signin_session");

		if (trackedSession !== userId) {
			console.log("New auth session detected, tracking sign in event");
			identifyUser(userId);
			trackEvent("user_signed_in", { platform: "desktop" });
			localStorage.setItem("tracked_signin_session", userId);
		} else {
			console.log("Auth session already tracked, skipping sign in event");
		}
	});

	onMount(() => {
		// Enforce window size with multiple safeguards
		const currentWindow = getCurrentWindow();

		// Check size when app regains focus
		const unlistenFocus = currentWindow.onFocusChanged(({ payload: focused }) => {
			if (focused) {
				const size = getWindowSize();

				currentWindow.setSize(new LogicalSize(size.width, size.height));
			}
		});

		// Listen for resize events
		const unlistenResize = currentWindow.onResized(() => {
			const size = getWindowSize();

			currentWindow.setSize(new LogicalSize(size.width, size.height));
		});

		onCleanup(async () => {
			(await unlistenFocus)?.();
			(await unlistenResize)?.();
		});
	});

	createEffect(() => {
		const size = getWindowSize();
		getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
	});

	const screens = createQuery(() => listScreens);
	const windows = createQuery(() => listWindows);
	const cameras = createVideoDevicesQuery();
	const mics = createQuery(() => listAudioDevices);

	// these all avoid suspending
	const _screens = () => (screens.isPending ? [] : screens.data);
	const _windows = () => (windows.isPending ? [] : windows.data);
	const _mics = () => (mics.isPending ? [] : mics.data);

	// these options take the raw config values and combine them with the available options,
	// allowing us to define fallbacks if the selected options aren't actually available
	const options = {
		screen: () => {
			let screen: CaptureDisplay | undefined;

			if (rawOptions.captureTarget.variant === "display") {
				const screenId = rawOptions.captureTarget.id;
				screen = _screens()?.find((s: any) => s.id === screenId) ?? _screens()?.[0];
			} else if (rawOptions.captureTarget.variant === "area") {
				const screenId = rawOptions.captureTarget.screen;
				screen = _screens()?.find((s: any) => s.id === screenId) ?? _screens()?.[0];
			}

			return screen;
		},
		window: () => {
			let win: CaptureWindow | undefined;

			if (rawOptions.captureTarget.variant === "window") {
				const windowId = rawOptions.captureTarget.id;
				win = _windows()?.find((s: any) => s.id === windowId) ?? _windows()?.[0];
			}

			return win;
		},
		cameraID: () =>
			cameras.find((c) => {
				const { cameraID } = rawOptions;
				if (!cameraID) return null;
				if ("ModelID" in cameraID && c.model_id === cameraID.ModelID) return c;
				if ("DeviceID" in cameraID && c.device_id === cameraID.DeviceID) return c;
				return null;
			}),
		micName: () => mics.data?.find((name: any) => name === rawOptions.micName),
	};

	// if target is window and no windows are available, switch to screen capture
	createEffect(() => {
		const screen = _screens()?.[0];
		if (rawOptions.captureTarget.variant === "window" && !windows.isPending && _windows()?.length === 0 && screen) {
			setOptions("captureTarget", reconcile({ variant: "display", id: screen.id }));
		}
	});

	const toggleRecording = createMutation(() => ({
		mutationFn: async (payload: { mode: RecordingMode }) => {
			if (!isRecording()) {
				const capture_target = ((): ScreenCaptureTarget => {
					switch (rawOptions.captureTarget.variant) {
						case "display": {
							const screen = options.screen();
							if (!screen) throw new Error(`No screen found. Number of available screens: ${_screens()?.length}`);
							return { variant: "display", id: screen.id };
						}
						case "window": {
							const win = options.window();
							if (!win) throw new Error(`No window found. Number of available windows: ${_windows()?.length}`);
							return { variant: "window", id: win.id };
						}
						case "area": {
							const screen = options.screen();
							if (!screen) throw new Error(`No screen found. Number of available screens: ${_screens()?.length}`);
							return {
								variant: "area",
								bounds: rawOptions.captureTarget.bounds,
								screen: screen.id,
							};
						}
					}
				})();

				await handleRecordingResult(
					commands.startRecording({
						capture_target,
						mode: payload.mode,
						capture_system_audio: rawOptions.captureSystemAudio,
					}),
					setOptions
				);
			} else await commands.stopRecording();
		},
	}));

	const setMicInput = createMutation(() => ({
		mutationFn: async (name: string | null) => {
			await commands.setMicInput(name);
			setOptions("micName", name);
		},
	}));

	const setCamera = createCameraMutation();

	onMount(() => {
		if (rawOptions.micName) commands.setMicInput(rawOptions.micName);
		if (rawOptions.cameraID) setCamera.rawMutate(rawOptions.cameraID);
	});

	return (
		<div class="flex justify-center flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] h-full text-[--text-primary]">
			<WindowChromeHeader hideMaximize>
				<div dir={ostype() === "windows" ? "rtl" : "rtl"} class="flex gap-1 items-center mx-2">
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
					<Tooltip content={<span>Recordings</span>}>
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
			<div class="flex items-center justify-between pb-[0.25rem]">
				<div class="flex items-center space-x-1">
					<a
						class="*:w-[92px] *:h-auto text-[--text-primary]"
						target="_blank"
						href={auth.data ? `${import.meta.env.VITE_SERVER_URL}/dashboard` : import.meta.env.VITE_SERVER_URL}
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
										: "bg-gray-3 cursor-pointer hover:bg-gray-5"
								)}
							>
								{license.data?.type === "commercial" ? "Commercial" : license.data?.type === "pro" ? "Pro" : "Personal"}
							</span>
						</Suspense>
					</ErrorBoundary>
				</div>
				<Mode />
			</div>
			<div>
				<AreaSelectButton
					screen={options.screen()}
					targetVariant={rawOptions.captureTarget.variant === "window" ? "other" : rawOptions.captureTarget.variant}
					onChange={(area) => {
						const screen = options.screen();
						if (!screen) return;
						if (!area)
							setOptions(
								"captureTarget",
								reconcile({
									variant: "display",
									id: screen.id,
								})
							);
					}}
				/>
				<div
					class={cx(
						"flex flex-row items-center rounded-[0.5rem] relative border h-8 transition-all duration-500",
						(rawOptions.captureTarget.variant === "display" || rawOptions.captureTarget.variant === "area") &&
							"ml-[2.4rem]"
					)}
					style={{
						"transition-timing-function": "cubic-bezier(0.785, 0.135, 0.15, 0.86)",
					}}
				>
					<div
						class="w-1/2 absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden"
						style={{
							transform: rawOptions.captureTarget.variant === "window" ? "translateX(100%)" : undefined,
						}}
					>
						<div class="flex-1 bg-gray-2" />
					</div>
					<TargetSelect<CaptureDisplay>
						options={_screens() ?? []}
						onChange={(value) => {
							if (!value) return;

							trackEvent("display_selected", {
								display_id: value.id,
								display_name: value.name,
								refresh_rate: value.refresh_rate,
							});

							setOptions("captureTarget", reconcile({ variant: "display", id: value.id }));
						}}
						value={options.screen() ?? null}
						placeholder="Display"
						optionsEmptyText="No screens found"
						selected={rawOptions.captureTarget.variant === "display" || rawOptions.captureTarget.variant === "area"}
					/>
					<TargetSelect<CaptureWindow>
						options={_windows() ?? []}
						onChange={(value) => {
							if (!value) return;

							trackEvent("window_selected", {
								window_id: value.id,
								window_name: value.name,
								owner_name: value.owner_name,
								refresh_rate: value.refresh_rate,
							});

							setOptions("captureTarget", reconcile({ variant: "window", id: value.id }));
						}}
						value={options.window() ?? null}
						placeholder="Window"
						optionsEmptyText="No windows found"
						selected={rawOptions.captureTarget.variant === "window"}
						getName={(value) => (platform() === "windows" ? value.name : `${value.owner_name} | ${value.name}`)}
						disabled={_windows()?.length === 0}
					/>
				</div>
			</div>
			<CameraSelect
				options={cameras}
				value={options.cameraID() ?? null}
				onChange={(v) => {
					if (!v) setCamera.mutate(null);
					else if (v.model_id) setCamera.mutate({ ModelID: v.model_id });
					else setCamera.mutate({ DeviceID: v.device_id });
				}}
			/>
			<MicrophoneSelect
				disabled={mics.isPending}
				options={_mics() ?? []}
				// this prevents options.micName() from suspending on initial load
				value={mics.isPending ? rawOptions.micName : options.micName() ?? null}
				onChange={(v) => setMicInput.mutate(v)}
			/>
			<SystemAudio />
			<div class="flex items-center space-x-1 w-full">
				{rawOptions.mode === "instant" && !auth.data ? (
					<SignInButton>
						Sign In for <IconCapInstant class="invert-0 dark:invert size-[0.8rem] mx-1" />
						Instant Mode
					</SignInButton>
				) : (
					<Tooltip
						childClass="w-full flex"
						placement="top"
						content={
							<>
								Instant Mode recordings are limited
								<br /> to 5 mins,{" "}
								<button class="underline" onClick={() => commands.showWindow("Upgrade")}>
									Upgrade to Pro
								</button>
							</>
						}
						openDelay={0}
						closeDelay={0}
						disabled={!(rawOptions.mode === "instant" && auth.data?.plan?.upgraded === false)}
					>
						<Button
							disabled={toggleRecording.isPending}
							variant="blue"
							size="md"
							onClick={() => toggleRecording.mutate({ mode: rawOptions.mode })}
							class="flex flex-grow justify-center items-center"
						>
							{isRecording() ? (
								"Stop Recording"
							) : (
								<>
									{rawOptions.mode === "instant" ? (
										<IconCapInstant
											class={cx("size-[0.8rem] mr-1.5", toggleRecording.isPending ? "opacity-50" : "opacity-100")}
										/>
									) : (
										<IconCapFilmCut
											class={cx(
												"size-[0.8rem] mr-2 -mt-[1.5px]",
												toggleRecording.isPending ? "opacity-50" : "opacity-100"
											)}
										/>
									)}
									{rawOptions.mode === "instant" && auth.data?.plan?.upgraded === false
										? "Start 5 min recording"
										: "Start recording"}
								</>
							)}
						</Button>
					</Tooltip>
				)}
			</div>
		</div>
	);
}

import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype, platform } from "@tauri-apps/plugin-os";
import * as updater from "@tauri-apps/plugin-updater";
import { Transition } from "solid-transition-group";
import { SignInButton } from "~/components/SignInButton";
import { authStore, generalSettingsStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { handleRecordingResult } from "~/utils/recording";
import { apiClient } from "~/utils/web-api";
import { WindowChromeHeader } from "./Context";
import { CameraSelectBase } from "./new-main/CameraSelect";
import { MicrophoneSelectBase } from "./new-main/MicrophoneSelect";
import { SystemAudioToggleRoot } from "./new-main/SystemAudio";
import { RecordingOptionsProvider, useRecordingOptions } from "./OptionsContext";

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
			`Version ${update.version} of Inflight is available, would you like to install it?`,
			{ title: "Update Inflight", okLabel: "Update", cancelLabel: "Ignore" }
		);

		if (!shouldUpdate) return;
		navigate("/update");
	});
}

function AreaSelectButton(props: {
	targetVariant: "display" | "area" | "other";
	screen: CaptureDisplay | undefined;
	onChange(area?: number): void;
}) {
	const [areaSelection, setAreaSelection] = createStore({ pending: false });

	async function closeAreaSelection() {
		setAreaSelection({ pending: false });
		(await WebviewWindow.getByLabel("capture-area"))?.close();
	}

	createEffect(() => {
		if (props.targetVariant === "other") closeAreaSelection();
	});

	async function handleAreaSelectButtonClick() {
		closeAreaSelection();
		if (props.targetVariant === "area") {
			trackEvent("crop_area_disabled");
			props.onChange();
			return;
		}

		const { screen } = props;
		if (!screen) return;

		trackEvent("crop_area_enabled", {
			screen_id: screen.id,
			screen_name: screen.name,
		});
		setAreaSelection({ pending: false });
		commands.showWindow({
			CaptureArea: { screen_id: screen.id },
		});
	}

	createTauriEventListener(events.setCaptureAreaPending(getCurrentWebviewWindow()), (pending) =>
		setAreaSelection("pending", pending)
	);

	return (
		<Tooltip
			openDelay={500}
			content={
				props.targetVariant === "area"
					? "Remove selection"
					: areaSelection.pending
					? "Selecting area..."
					: "Select area"
			}
			childClass="flex fixed flex-row items-center w-8 h-8"
		>
			<Transition
				onEnter={(el, done) => {
					el.animate(
						[
							{
								transform: "scale(0.5)",
								opacity: 0,
								width: "0.2rem",
								height: "0.2rem",
							},
							{
								transform: "scale(1)",
								opacity: 1,
								width: "2rem",
								height: "2rem",
							},
						],
						{
							duration: 450,
							easing: "cubic-bezier(0.65, 0, 0.35, 1)",
						}
					).finished.then(done);
				}}
				onExit={(el, done) =>
					el
						.animate(
							[
								{
									transform: "scale(1)",
									opacity: 1,
									width: "2rem",
									height: "2rem",
								},
								{
									transform: "scale(0)",
									opacity: 0,
									width: "0.2rem",
									height: "0.2rem",
								},
							],
							{
								duration: 500,
								easing: "ease-in-out",
							}
						)
						.finished.then(done)
				}
			>
				<Show when={props.targetVariant !== "other"}>
					{(targetScreenOrArea) => (
						<button
							type="button"
							disabled={!targetScreenOrArea}
							onClick={handleAreaSelectButtonClick}
							class={cx(
								"flex items-center justify-center flex-shrink-0 w-full h-full rounded-[0.5rem] transition-all duration-200",
								"hover:bg-gray-3 disabled:bg-gray-2 disabled:text-gray-11",
								"focus-visible:outline font-[200] text-[0.875rem]",
								props.targetVariant === "area"
									? "bg-gray-2 text-blue-9 border border-blue-200"
									: "bg-gray-2 text-gray-11"
							)}
						>
							<IconCapCrop
								class={cx(
									"w-[1rem] h-[1rem]",
									areaSelection.pending && "animate-gentle-bounce duration-1000 text-gray-12 mt-1"
								)}
							/>
						</button>
					)}
				</Show>
			</Transition>
		</Tooltip>
	);
}

function CameraSelect(props: {
	disabled?: boolean;
	options: CameraInfo[];
	value: CameraInfo | null;
	onChange: (cameraInfo: CameraInfo | null) => void;
}) {
	return (
		<CameraSelectBase
			{...props}
			PillComponent={InfoPill}
			class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full disabled:text-gray-11 transition-colors KSelect"
			iconClass="text-gray-11 size-[1.25rem]"
		/>
	);
}

function MicrophoneSelect(props: {
	disabled?: boolean;
	options: string[];
	value: string | null;
	onChange: (micName: string | null) => void;
}) {
	return (
		<MicrophoneSelectBase
			{...props}
			class="relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full disabled:text-gray-11 transition-colors KSelect overflow-hidden z-10"
			levelIndicatorClass="bg-blue-100"
			iconClass="text-gray-11 size-[1.25rem]"
			PillComponent={InfoPill}
		/>
	);
}

function SystemAudio() {
	return (
		<SystemAudioToggleRoot
			class="relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full disabled:text-gray-11 transition-colors KSelect overflow-hidden z-10"
			PillComponent={InfoPill}
			icon={
				<div class="size-[1.25rem] flex items-center justify-center">
					<IconPhMonitorBold class="text-gray-11 stroke-2 size-[1.2rem]" />
				</div>
			}
		/>
	);
}

function TargetSelect<T extends { id: string; name: string }>(props: {
	options: Array<T>;
	onChange: (value: T) => void;
	value: T | null;
	selected: boolean;
	optionsEmptyText: string;
	placeholder: string;
	getName?: (value: T) => string;
	disabled?: boolean;
}) {
	const value = () => {
		const v = props.value;
		if (!v) return null;

		const o = props.options.find((o) => o.id === v.id);
		if (o) return props.value;

		props.onChange(props.options[0]);
		return props.options[0];
	};

	const getName = (value?: T) => (value ? props.getName?.(value) ?? value.name : props.placeholder);

	return (
		<button
			type="button"
			class="group flex-1 text-gray-11 py-1 z-10 data-[selected='true']:text-gray-12 disabled:text-gray-10 peer focus:outline-none transition-colors duration-100 w-full text-nowrap overflow-hidden px-2 flex gap-2 items-center justify-center"
			data-selected={props.selected}
			disabled={props.disabled}
			onClick={() => {
				if (props.options.length > 1) {
					Promise.all(
						props.options.map((o) =>
							CheckMenuItem.new({
								text: getName(o),
								checked: o === props.value,
								action: () => props.onChange(o),
							})
						)
					)
						.then((items) => Menu.new({ items }))
						.then((m) => {
							m.popup();
						});
				} else if (props.options.length === 1) props.onChange(props.options[0]);
			}}
		>
			{props.options.length <= 1 ? (
				<span class="truncate">{value()?.name ?? props.placeholder}</span>
			) : (
				<>
					<span class="truncate">{value()?.name ?? props.placeholder}</span>
					<IconCapChevronDown class="shrink-0 size-4" />
				</>
			)}
		</button>
	);
}

function InfoPill(props: ComponentProps<"button"> & { variant: "blue" | "red" | "on" | "off" }) {
	return (
		<button
			{...props}
			type="button"
			class={cx(
				"px-[0.375rem] rounded-full text-[0.75rem]",
				props.variant === "blue" ? "bg-blue-3 text-blue-9" : "bg-red-3 text-red-9"
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
		{ name: "changelogState" }
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
		}
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
			if (hasUpdate === true && changelogState.lastOpenedVersion !== currentVersion()) {
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
			<button type="button" onClick={handleChangelogClick} class="flex relative justify-center items-center w-5 h-5">
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
