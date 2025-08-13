import { useNavigate } from "@solidjs/router";
import {
  createMutation, useQuery
} from "@tanstack/solid-query";
import {
  getCurrentWindow,
  LogicalSize,
  primaryMonitor
} from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import * as updater from "@tauri-apps/plugin-updater";
import {
  createEffect, onCleanup,
  onMount
} from "solid-js";

import { reconcile } from "solid-js/store";

import {
  createCameraMutation, listAudioDevices,
  listScreens,
  listVideoDevices,
  listWindows
} from "~/utils/queries";
import {
  CameraInfo, commands,
  DeviceOrModelID, ScreenCaptureTarget
} from "~/utils/tauri";
import Tooltip from "~/components/Tooltip";
import CameraSelect from "./CameraSelect";
import MicrophoneSelect from "./MicrophoneSelect";
import SystemAudio from "./SystemAudio";
import ChangelogButton from "./ChangeLogButton";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { WindowChromeHeader } from "./Context";
import TargetTypeButton from "./TargetTypeButton";
import { generalSettingsStore } from "~/store";
import { createEventListener } from "@solid-primitives/event-listener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { RecordingOptionsProvider, useRecordingOptions } from "./OptionsContext";

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

			if (rawOptions.captureTarget.variant === "screen") {
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
		target: (): ScreenCaptureTarget => {
			switch (rawOptions.captureTarget.variant) {
				case "screen":
					return { variant: "screen", id: options.screen()?.id ?? -1 };
				case "window":
					return { variant: "window", id: options.window()?.id ?? -1 };
				case "area":
					return {
						variant: "area",
						bounds: rawOptions.captureTarget.bounds,
						screen: options.screen()?.id ?? -1,
					};
			}
		},
	};

	// if target is window and no windows are available, switch to screen capture
	createEffect(() => {
		if (options.target().variant === "window" && windows.data?.length === 0) {
			setOptions(
				"captureTarget",
				reconcile({
					variant: "screen",
					id: options.screen()?.id ?? -1,
				}),
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
    <div class="flex justify-center flex-col px-3 gap-2 h-full text-[--text-primary]">
      <WindowChromeHeader hideMaximize>
        <div
          dir={ostype() === "windows" ? "rtl" : "rtl"}
          class="flex gap-1 items-center mx-2"
        >
          <div class="flex gap-1 items-center">
          <Tooltip content={<span>Settings</span>}>
            <button
              type="button"
              onClick={async () => {
                await commands.showWindow({ Settings: { page: "general" } });
                getCurrentWindow().hide();
              }}
              class="flex items-center justify-center w-5 h-5 -ml-[1.5px]"
            >
              <IconCapSettings class="transition-colors text-gray-11 size-3.5 hover:text-gray-12" />
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
              <IconLucideSquarePlay class="transition-colors text-gray-11 size-3.5 hover:text-gray-12" />
            </button>
          </Tooltip>
          <ChangelogButton/>
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => {
                new WebviewWindow("debug", { url: "/debug" });
              }}  
              class="flex justify-center items-center"
            >
              <IconLucideBug class="transition-colors text-gray-11 size-3.5 hover:text-gray-12" />
            </button>
          )}
          </div>

        </div>
      </WindowChromeHeader>
      <div class="flex flex-row gap-2 items-stretch w-full text-xs text-gray-11">
        <TargetTypeButton
          selected={rawOptions.targetMode === "screen"}
          Component={IconMdiMonitor}
          onClick={() =>
            setOptions("targetMode", (v) => (v === "screen" ? null : "screen"))
          }
          name="Screen"
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
        options={mics.isPending ? [] : mics.data ?? []}
        // this prevents options.micName() from suspending on initial load
        value={mics.isPending ? rawOptions.micName : options.micName() ?? null}
        onChange={(v) => setMicInput.mutate(v)}
      />
      <SystemAudio />
              
      </div>
    </div>
  );
}
