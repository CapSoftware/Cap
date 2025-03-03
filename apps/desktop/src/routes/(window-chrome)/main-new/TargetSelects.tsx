import { createQuery } from "@tanstack/solid-query";
import {
  WebviewWindow,
  getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { cx } from "cva";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { trackEvent } from "~/utils/analytics";
import { createOptionsQuery, listScreens } from "~/utils/queries";
import { commands } from "~/utils/tauri";

function TargetSelects(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
}) {
  const screens = createQuery(() => listScreens);
  const [selectedScreen, setSelectedScreen] = createSignal<{
    id: number;
  } | null>(screens?.data?.[0] ?? null);

  const isTargetScreenOrArea = createMemo(
    () =>
      props.options?.captureTarget.variant === "screen" ||
      props.options?.captureTarget.variant === "area"
  );
  const isTargetCaptureArea = createMemo(
    () => props.options?.captureTarget.variant === "area"
  );
  const isTargetScreen = createMemo(
    () => props.options?.captureTarget.variant === "screen"
  );

  const [areaSelection, setAreaSelection] = createStore({
    pending: false,
    screen: selectedScreen(),
  });

  async function closeAreaSelection() {
    setAreaSelection({ pending: false, screen: null });
    (await WebviewWindow.getByLabel("capture-area"))?.close();
  }

  onMount(async () => {
    const unlistenCaptureAreaWindow =
      await getCurrentWebviewWindow().listen<boolean>(
        "cap-window://capture-area/state/pending",
        (event) => {
          setAreaSelection("pending", event.payload);
        }
      );
    onCleanup(unlistenCaptureAreaWindow);
  });

  async function handleAreaSelectButtonClick() {
    const screen = screens.data?.[0];
    if (!screen) return;
    closeAreaSelection();
    trackEvent("crop_area_enabled", {
      screen_id: screen.id,
      screen_name: screen.name,
    });
    setAreaSelection({ pending: false, screen: { id: screen.id } });
    commands.showWindow({
      CaptureArea: { screen_id: screen.id },
    });
  }

  const ScreenWindowHandler = async () => {
    (await WebviewWindow.getByLabel("main-new"))?.minimize();
    await commands.showWindow("TargetOverlay");
  };

  return (
    <>
      <div class="grid grid-cols-3 gap-3 w-full h-[56px]">
        <button
          type="button"
          onClick={handleAreaSelectButtonClick}
          class={cx(
            "flex flex-col flex-1 gap-1 justify-center items-center rounded-lg transition-shadow duration-200 bg-zinc-200",
            "border ring-offset-2 border-zinc-300 dark:bg-zinc-200 dark:border-zinc-300 ring-offset-zinc-200 hover:outline-none hover:ring-2 hover:ring-blue-300"
          )}
        >
          <IconCapScan
            class={cx(
              "w-5",
              isTargetCaptureArea()
                ? "text-black dark:text-white"
                : "text-zinc-400"
            )}
          />
          <p class="text-[13px] font-medium text-black dark:text-white">Area</p>
        </button>
        <button
          onClick={ScreenWindowHandler}
          type="button"
          class={cx(
            "flex flex-col flex-1 gap-1 justify-center items-center rounded-lg transition-shadow duration-200 bg-zinc-200",
            "border ring-offset-2 border-zinc-300 dark:bg-zinc-200 dark:border-zinc-300 ring-offset-zinc-200 hover:outline-none hover:ring-2 hover:ring-blue-300"
          )}
        >
          <IconCapMonitor class={cx("w-5 text-zinc-400")} />
          <p class="text-[13px] font-medium text-black dark:text-white">
            Screen
          </p>
        </button>
        <button
          onClick={ScreenWindowHandler}
          type="button"
          class={cx(
            "flex flex-col flex-1 gap-1 justify-center items-center rounded-lg transition-shadow duration-200 bg-zinc-200",
            "border ring-offset-2 border-zinc-300 dark:bg-zinc-200 dark:border-zinc-300 ring-offset-zinc-200 hover:outline-none hover:ring-2 hover:ring-blue-300"
          )}
        >
          <IconCapWindow class={cx("w-5 text-zinc-400")} />
          <p class="text-[13px] font-medium text-black dark:text-white">
            Window
          </p>
        </button>
      </div>
    </>
  );
}

export default TargetSelects;
