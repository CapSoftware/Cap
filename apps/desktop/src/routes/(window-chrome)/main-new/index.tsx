import { createMutation } from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createResource, onCleanup } from "solid-js";

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  createCurrentRecordingQuery,
  createOptionsQuery,
} from "~/utils/queries";
import { commands } from "~/utils/tauri";
import { setTitlebar } from "~/utils/titlebar-state";
import { CameraSelect, MicrophoneSelect } from "./InputSelects";
import TargetSelects from "./TargetSelects";

export default function () {
  const { options, setOptions } = createOptionsQuery();
  const currentRecording = createCurrentRecordingQuery();

  const isRecording = () => !!currentRecording.data;

  const toggleRecording = createMutation(() => ({
    mutationFn: async () => {
      if (!isRecording()) {
        await commands.startRecording();
      } else {
        await commands.stopRecording();
      }
    },
  }));

  createUpdateCheck();

  let unlistenFn: UnlistenFn;
  onCleanup(() => unlistenFn?.());
  const [initialize] = createResource(async () => {
    const version = await getVersion();

    if (options.data?.cameraLabel && options.data.cameraLabel !== "No Camera") {
      const cameraWindowActive = await commands.isCameraWindowOpen();

      if (!cameraWindowActive) {
        console.log("cameraWindow not found");
        setOptions.mutate({
          ...options.data,
        });
      }
    }

    // Enforce window size with multiple safeguards
    const currentWindow = getCurrentWindow();
    const MAIN_WINDOW_SIZE = { width: 300, height: 272 };

    // Set initial size
    await currentWindow.setSize(
      new LogicalSize(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height)
    );

    // Check size when app regains focus
    const unlistenFocus = await currentWindow.onFocusChanged(
      ({ payload: focused }) => {
        if (focused) {
          currentWindow.setSize(
            new LogicalSize(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height)
          );
        }
      }
    );

    // Listen for resize events
    const unlistenResize = await currentWindow.onResized(() => {
      currentWindow.setSize(
        new LogicalSize(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height)
      );
    });

    unlistenFn = () => {
      unlistenFocus();
      unlistenResize();
    };

    setTitlebar("hideMaximize", true);
    setTitlebar(
      "items",
      <div class="flex items-center mx-2">
        <div onClick={showMenu}>
          <IconCapEllipsis class="w-full text-gray-500" />
        </div>
      </div>
    );

    return null;
  });

  return (
    <div class="flex justify-center flex-col p-3 gap-2 text-[0.875rem] font-[400] bg-[--gray-50] h-full text-[--text-primary]">
      {initialize()}
      <div class="*:h-auto mb-3 text-[--text-primary] ">
        <IconCapDarkLogoNoBox class="hidden dark:block" />
        <IconCapLogoNobox class="block dark:hidden" />
      </div>
      <TargetSelects options={options.data} />
      <CameraSelect options={options.data} setOptions={setOptions} />
      <MicrophoneSelect options={options.data} setOptions={setOptions} />
    </div>
  );
}

import { useNavigate } from "@solidjs/router";
import * as dialog from "@tauri-apps/plugin-dialog";
import * as updater from "@tauri-apps/plugin-updater";
import { onMount } from "solid-js";

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

async function showMenu(event: MouseEvent) {
  event.preventDefault();

  // Create the menu
  const menu = await Menu.new({
    items: [
      {
        id: "settings",
        text: "Settings",
        action: () => commands.showWindow({ Settings: { page: "general" } }),
      },
      { id: "notifications", text: "Notifications", action: () => console.log("to-do") },
      {
        id: "prevRecordings",
        text: "Previous Recordings",
        action: () => commands.showWindow({ Settings: { page: "recordings" } }),
      },
      {
        id: "changelog",
        text: "Changelog",
        action: () => commands.showWindow({ Settings: { page: "changelog" } }),
      },
      { id: "help", text: "Help" },
    ],
  });

  // Show the menu at the calculated position
  await menu.popup();
}
