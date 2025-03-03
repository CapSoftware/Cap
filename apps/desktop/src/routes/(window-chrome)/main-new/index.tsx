import { getVersion } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createResource, onCleanup } from "solid-js";

import type { UnlistenFn } from "@tauri-apps/api/event";
import { ErrorBoundary, Suspense } from "solid-js";
import { Mode } from "~/components";
import {
  createCurrentRecordingQuery,
  createLicenseQuery,
  createOptionsQuery,
} from "~/utils/queries";
import { commands } from "~/utils/tauri";
import { setTitlebar } from "~/utils/titlebar-state";
import { CameraSelect, MicrophoneSelect } from "./InputSelects";
import TargetSelects from "./TargetSelects";

export default function () {
  const { options, setOptions } = createOptionsQuery();
  const currentRecording = createCurrentRecordingQuery();

  const license = createLicenseQuery();

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
    const MAIN_WINDOW_SIZE = { width: 300, height: 300 };

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
    <div class="flex justify-center flex-col p-3 gap-2 text-[0.875rem] font-[400] bg-zinc-150 h-full text-[--text-primary]">
      {initialize()}
      <div class="flex flex-1 gap-2 justify-between items-center">
        <div class="*:h-auto flex flex-col gap-2 mb-2 text-[--text-primary] ">
          <IconCapDarkLogoNoBox class="hidden dark:block" />
          <IconCapLogoNobox class="block dark:hidden" />
          <ErrorBoundary fallback={<></>}>
            <Suspense>
              <span
                onClick={async () => {
                  if (license.data?.type !== "pro") {
                    await commands.showWindow("Upgrade");
                  }
                }}
                class={`text-[0.6rem] w-fit ${
                  license.data?.type === "pro"
                    ? "bg-[--blue-400] text-zinc-400"
                    : "bg-zinc-300 cursor-pointer border border-zinc-350 hover:bg-zinc-350 transition-colors duration-200"
                } rounded-full px-2 py-1`}
              >
                {license.data?.type === "commercial"
                  ? "Commercial License"
                  : license.data?.type === "pro"
                  ? "Pro"
                  : "Personal License"}
              </span>
            </Suspense>
          </ErrorBoundary>
        </div>
        <Mode />
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
        id: "prevRecordings",
        text: "Previous Recordings",
        action: () => commands.showWindow({ Settings: { page: "recordings" } }),
      },
      {
        id: "prevScreenshots",
        text: "Previous Screenshots",
        action: () =>
          commands.showWindow({ Settings: { page: "screenshots" } }),
      },
      {
        id: "changelog",
        text: "Changelog",
        action: () => commands.showWindow({ Settings: { page: "changelog" } }),
      },
      {
        id: "settings",
        text: "Settings",
        action: () => commands.showWindow({ Settings: { page: "general" } }),
      },
      {
        id: "feedback",
        text: "Feedback",
        action: () => commands.showWindow({ Settings: { page: "feedback" } }),
      },
    ],
  });

  // Show the menu at the calculated position
  await menu.popup();
}
