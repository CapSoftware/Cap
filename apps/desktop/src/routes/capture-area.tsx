
import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js";
import { EditorButton, Input, MenuItem, MenuItemList, PopperContent } from "./editor/ui";
import { Select as KSelect } from "@kobalte/core/select";
import type { AspectRatio } from "~/utils/tauri";
import { ASPECT_RATIOS } from "./editor/projectConfig";
import { createCurrentRecordingQuery, createOptionsQuery } from "~/utils/queries";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export default function () {
  const { options, setOptions } = createOptionsQuery();
  const currentRecording = createCurrentRecordingQuery();

  return <CaptureAreaCropper options={{ options, setOptions }} />
}

function CaptureAreaCropper(props: {
  options: ReturnType<typeof createOptionsQuery>;
}) {
  const webview = getCurrentWebviewWindow();

  const { options, setOptions } = createOptionsQuery();
  const setPendingState = (pending: boolean) =>
    webview.emitTo("main", "cap-window://capture-area/state/pending", pending);

  onMount(async () => {
    webview.emitTo("main", "cap-window://capture-area/state/pending", true);
    const unlisten = await webview.onCloseRequested(() => setPendingState(false));
    onCleanup(unlisten);
  });

  function handleConfirm() {
    const target = options.data?.captureTarget;
    if (!options.data || !target || target.variant !== "screen") return;
    setPendingState(false);

    // setOptions.mutate({
    //   ...options.data,
    //   captureTarget: {
    //     variant: "area",
    //     screen: target,
    //     bounds: {
    //       x: crop.position.x,
    //       y: crop.position.y,
    //       width: crop.size.x,
    //       height: crop.size.y,
    //     },
    //   },
    // });
  }

  return <div class="w-screen h-screen overflow-hidden">
    <div class="fixed w-full z-50 bg-red-transparent-20 flex items-center justify-center mt-20">
      <div class="absolute w-[48rem] h-12 bg-gray-50 rounded-lg drop-shadow-2xl border border-1 border-gray-100 flex flex-row-reverse justify-around gap-3 p-1 *:transition-all *:duration-200">
        <div class="flex flex-row">
          <button
            class="py-[0.25rem] px-[0.5rem] text-red-300 dark:red-blue-300 gap-[0.25rem] hover:bg-red-50 flex flex-row items-center rounded-lg"
            type="button"
          >
            <IconCapCircleX />
            <span class="font-[500] text-[0.875rem]">
              Discard
            </span>
          </button>
          <button
            class="py-[0.25rem] px-[0.5rem] text-blue-300 dark:text-blue-300 gap-[0.25rem] hover:bg-blue-50 flex flex-row items-center rounded-lg"
            type="button"
            onClick={handleConfirm}
          >
            <IconCapCircleCheck />
            <span class="font-[500] text-[0.875rem]">
              Confirm selection
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
}