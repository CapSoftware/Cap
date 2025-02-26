import { createQuery } from "@tanstack/solid-query";
import {
  WebviewWindow,
  getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { cx } from "cva";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { createStore } from "solid-js/store";
import { TargetSelect } from "~/components";
import { trackEvent } from "~/utils/analytics";
import { createOptionsQuery, listScreens, listWindows } from "~/utils/queries";
import type { CaptureScreen, CaptureWindow } from "~/utils/tauri";
import { commands } from "~/utils/tauri";

function TargetSelects(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
}) {
  const screens = createQuery(() => listScreens);
  const windows = createQuery(() => listWindows);
  const [selectedScreen, setSelectedScreen] =
    createSignal<CaptureScreen | null>(screens?.data?.[0] ?? null);

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

  let shouldAnimateAreaSelect = false;
  createEffect(async () => {
    const target = props.options?.captureTarget;
    if (!target) return;

    if (target.variant === "screen") {
      if (target.id !== areaSelection.screen?.id) {
        closeAreaSelection();
      }
      setSelectedScreen(target);
    } else if (target.variant === "window") {
      if (areaSelection.screen) closeAreaSelection();
      shouldAnimateAreaSelect = true;
    }
  });

  async function handleAreaSelectButtonClick() {
    const targetScreen = selectedScreen() ?? screens.data?.[0];
    if (!targetScreen) return;

    closeAreaSelection();

    // if (isTargetCaptureArea() && props.options) {
    //   trackEvent("crop_area_disabled");
    //   commands.setRecordingOptions({
    //     ...props.options,
    //     captureTarget: { ...targetScreen, variant: "screen" },
    //   });
    //   return;
    // }

    trackEvent("crop_area_enabled", {
      screen_id: targetScreen.id,
      screen_name: targetScreen.name,
    });
    setAreaSelection({ pending: false, screen: targetScreen });
    commands.showWindow({
      CaptureArea: { screen: targetScreen },
    });
  }

  return (
    <>
      <div class="grid grid-cols-3 gap-3 w-full h-[56px]">
        <button
          type="button"
          onClick={handleAreaSelectButtonClick}
          class={cx(
            "flex flex-col flex-1 gap-1 justify-center items-center rounded-lg transition-shadow duration-200",
            isTargetCaptureArea()
              ? "ring-2 ring-blue-300 ring-offset-2 ring-offset-zinc-50 bg-zinc-300"
              : "bg-zinc-200"
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
        <TargetSelect<CaptureScreen>
          options={screens.data ?? []}
          isTargetCaptureArea={isTargetCaptureArea()}
          icon={
            <IconCapMonitor
              class={cx(
                "size-5",
                isTargetScreen()
                  ? "text-black dark:text-white"
                  : "text-zinc-400"
              )}
            />
          }
          areaSelectionPending={areaSelection.pending}
          onChange={(value) => {
            if (!value || !props.options) return;

            trackEvent("display_selected", {
              display_id: value.id,
              display_name: value.name,
              refresh_rate: value.refresh_rate,
            });

            commands.setRecordingOptions({
              ...props.options,
              captureTarget: { ...value, variant: "screen" },
            });
          }}
          value={
            props.options?.captureTarget.variant === "screen"
              ? props.options.captureTarget
              : null
          }
          placeholder={
            <p class="text-[13px] font-medium text-black dark:text-white">
              Screen
            </p>
          }
          class={cx(
            "flex flex-1 justify-center items-center rounded-lg",
            isTargetScreen() ? "bg-zinc-300" : "bg-zinc-200"
          )}
          optionsEmptyText="No screens found"
          selected={isTargetScreen()}
        />
        <TargetSelect<CaptureWindow>
          options={windows.data ?? []}
          isTargetCaptureArea={isTargetCaptureArea()}
          onChange={(value) => {
            if (!value || !props.options) return;

            trackEvent("window_selected", {
              window_id: value.id,
              window_name: value.name,
              owner_name: value.owner_name,
              refresh_rate: value.refresh_rate,
            });

            commands.setRecordingOptions({
              ...props.options,
              captureTarget: { ...value, variant: "window" },
            });
          }}
          value={
            props.options?.captureTarget.variant === "window"
              ? props.options.captureTarget
              : null
          }
          icon={
            <IconCapAppWindowMac
              class={cx(
                "size-5",
                props.options?.captureTarget.variant === "window"
                  ? "text-black dark:text-white"
                  : "text-zinc-400"
              )}
            />
          }
          placeholder={
            <p class="text-[13px] font-medium text-black dark:text-white">
              Window
            </p>
          }
          optionsEmptyText="No windows found"
          class={cx(
            "flex flex-1 justify-center items-center rounded-lg",
            props.options?.captureTarget.variant === "window"
              ? "bg-zinc-300"
              : "bg-zinc-200"
          )}
          selected={props.options?.captureTarget.variant === "window"}
        />
      </div>
    </>
  );
}

export default TargetSelects;
