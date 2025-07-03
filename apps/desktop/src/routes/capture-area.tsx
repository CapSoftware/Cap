import { Tooltip } from "@kobalte/core";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Transition } from "solid-transition-group";
import CropArea from "~/components/CropArea";
import { createOptionsQuery } from "~/utils/queries";
import { createCropController, CropBounds } from "~/utils/cropController";
import AltSwitch from "~/components/AltSwitch";

export default function CaptureArea() {
  const { rawOptions, setOptions } = createOptionsQuery();
  const webview = getCurrentWebviewWindow();

  const setPendingState = (pending: boolean) =>
    webview.emitTo("main", "cap-window://capture-area/state/pending", pending);

  const screenId: number | null =
    rawOptions.captureTarget.variant === "screen"
      ? rawOptions.captureTarget.id
      : null;

  let unlisten: () => void | undefined;
  onMount(async () => {
    setPendingState(true);
    unlisten = await webview.onCloseRequested(() => setPendingState(false));
  });
  onCleanup(() => unlisten?.());

  const [windowSize, setWindowSize] = createSignal({
    x: window.innerWidth,
    y: window.innerHeight,
  });

  onMount(() => {
    createEventListenerMap(window, {
      resize: () =>
        setWindowSize({ x: window.innerWidth, y: window.innerHeight }),
      keydown: (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "Enter") handleConfirm();
      },
    });
  });

  const [lastSelectedBounds, setLastSelectedBounds] = makePersisted(
    createStore<{ screenId: number; bounds: CropBounds }[]>([]),
    {
      name: "lastSelectedBounds",
    }
  );

  const cropController = createCropController({
    mappedSize: { x: windowSize().x, y: windowSize().y },
    // Try to find stored bounds for current screen
    initialCrop: (() => {
      if (!screenId) return undefined;
      return (
        lastSelectedBounds.find((item) => item.screenId === screenId)?.bounds ??
        undefined
      );
    })(),
  });

  async function handleConfirm() {
    const target = rawOptions.captureTarget;
    if (target.variant !== "screen") return;
    setPendingState(false);

    const currentBounds = cropController.crop();

    // Store the bounds for this screen
    if (screenId) {
      const existingIndex = lastSelectedBounds.findIndex(
        (item) => item.screenId === screenId
      );
      if (existingIndex >= 0) {
        setLastSelectedBounds(existingIndex, {
          screenId,
          bounds: currentBounds,
        });
      } else {
        setLastSelectedBounds([
          ...lastSelectedBounds,
          { screenId, bounds: currentBounds },
        ]);
      }
    }

    setOptions(
      "captureTarget",
      reconcile({
        variant: "area",
        screen: target.id,
        bounds: currentBounds,
      })
    );

    close();
  }

  const [visible, setVisible] = createSignal(true);
  function close() {
    setVisible(false);
    setTimeout(async () => {
      (await WebviewWindow.getByLabel("main"))?.unminimize();
      setPendingState(false);
      webview.close();
    }, 250);
  }

  return (
    <div class="overflow-hidden w-screen h-screen">
      <div class="flex fixed z-50 justify-center items-center w-full">
        <Transition
          appear
          enterActiveClass="fade-in animate-in slide-in-from-top-8"
          exitActiveClass="fade-out animate-out slide-out-to-top-8"
        >
          <Show when={visible()}>
            <div class="transition-all ease-out duration-250 absolute w-auto h-10 bg-gray-1 rounded-full drop-shadow-2xl overflow-visible border border-gray-3 outline outline-1 outline-gray-6 flex justify-around p-1 top-11">
              <button
                class="py-[0.25rem] px-2 text-gray-11 gap-[0.25rem] flex flex-row items-center rounded-full ml-0 right-auto"
                type="button"
                onClick={close}
              >
                <IconCapCircleX class="size-5" />
              </button>
              <div class="flex flex-row flex-grow gap-2 justify-center">
                <AltSwitch
                  normal={
                    <button
                      class="px-2 gap-[0.25rem] flex flex-row items-center rounded-[8px] grow justify-center transition-colors duration-200"
                      type="button"
                      onClick={() => cropController.fill()}
                    >
                      <IconLucideMaximize class="size-5" />
                      <span class="font-[500] text-[0.875rem]">Fill</span>
                    </button>
                  }
                  alt={
                    <button
                      class="px-2 gap-[0.25rem] flex flex-row items-center rounded-[8px] grow justify-center transition-colors duration-200"
                      type="button"
                      onClick={() => cropController.reset()}
                    >
                      <IconLucideMaximize class="size-5" />
                      <span class="font-[500] text-[0.875rem]">Reset</span>
                    </button>
                  }
                />
                <button
                  class="text-blue-9 px-2 gap-[0.25rem] hover:bg-blue-3 flex flex-row items-center rounded-full grow justify-center transition-colors duration-200"
                  type="button"
                  onClick={handleConfirm}
                >
                  <IconCapCircleCheck class="size-5" />
                  <span class="font-[500] text-[0.875rem]">
                    Confirm selection
                  </span>
                </button>
              </div>
            </div>
          </Show>
        </Transition>
      </div>

      <Transition
        appear
        enterActiveClass="fade-in animate-in"
        exitActiveClass="fade-out animate-out"
      >
        <Show when={visible()}>
          <CropArea controller={cropController} />
        </Show>
      </Transition>
    </div>
  );
}
