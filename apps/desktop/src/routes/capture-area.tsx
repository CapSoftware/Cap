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
import AreaSelection, { CropperRef } from "~/components/AreaSelection";
import Tooltip from "~/components/Tooltip";
import { type as ostype } from "@tauri-apps/plugin-os";

export default function CaptureArea() {
  let cropperRef: CropperRef | undefined;

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

  function reset() {
    cropperRef?.reset();
    if (!screenId) return;
    setLastSelectedBounds((values) =>
      values.filter((v) => v.screenId !== screenId)
    );
  }

  async function handleConfirm() {
    const target = rawOptions.captureTarget;
    if (target.variant !== "screen") return;
    setPendingState(false);

    const currentBounds = cropperRef?.bounds();
    if (!currentBounds) throw new Error("Cropper not initialized");

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
          enterActiveClass="fade-in animate-in slide-in-from-top-8 duration-500"
          exitActiveClass="fade-out animate-out slide-out-to-top-8"
        >
          <Show when={visible()}>
            <div
              class={`flex items-center p-1 gap-2 absolute w-auto h-14 rounded-full top-10 ${
                ostype() === "windows" ? "flex-row-reverse" : ""
              }`}
            >
              <Tooltip
                childClass="cursor-default rounded-full"
                openDelay={500}
                content={"Close"}
              >
                <button
                  class="flex items-center justify-center size-12 text-gray-11 shadow-md shadow-white-transparent-60 bg-gray-1 border border-gray-7 hover:bg-gray-4 active:bg-gray-6 rounded-full transition-colors duration-200 cursor-default"
                  type="button"
                  onClick={close}
                >
                  <IconLucideX class="size-5 *:pointer-events-none" />
                </button>
              </Tooltip>
              <div class="flex items-center h-full gap-2">
                <div class="flex items-center justify-between p-1 h-full shadow-md shadow-white-transparent-60 bg-gray-1 border border-gray-7 rounded-full gap-1">
                  <Tooltip
                    childClass="cursor-default rounded-full"
                    openDelay={500}
                    content={"Fill"}
                  >
                    <button
                      class="flex items-center justify-center size-10 text-gray-11 hover:bg-gray-5 active:bg-gray-6 rounded-full transition-colors duration-200 cursor-default"
                      type="button"
                      onClick={() => cropperRef?.fill()}
                    >
                      <IconLucideExpand class="size-5 *:pointer-events-none" />
                    </button>
                  </Tooltip>
                  <div class="inline-block h-full w-[1px] self-stretch bg-gray-5"></div>
                  <Tooltip
                    childClass="cursor-default rounded-full"
                    openDelay={500}
                    content={"Reset"}
                  >
                    <button
                      type="button"
                      class="flex items-center justify-center size-10 text-gray-11 hover:bg-gray-5 active:bg-gray-6 rounded-full transition-colors duration-200 cursor-default"
                      onClick={reset}
                    >
                      <IconLucideRotateCcw class="size-5 *:pointer-events-none" />
                    </button>
                  </Tooltip>
                </div>

                <div class="flex h-full">
                  <button
                    class="flex items-center justify-center px-4 h-full text-blue-10 shadow-md shadow-white-transparent-60 bg-gray-1 border border-gray-7 hover:border-blue-5 hover:bg-blue-1 active:bg-blue-2 rounded-full transition-all duration-200 gap-2 cursor-default"
                    type="button"
                    onClick={handleConfirm}
                  >
                    <IconCapCircleCheck class="size-5 *:pointer-events-none" />
                    <span class="font-medium text-sm">Confirm</span>
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </Transition>
      </div>

      <Transition
        appear
        enterActiveClass="fade-in animate-in duration-500"
        exitActiveClass="fade-out animate-out"
      >
        <Show when={visible()}>
          <AreaSelection
            ref={cropperRef}
            targetSize={windowSize()}
            initialCrop={() => {
              if (!screenId) return undefined;
              return (
                lastSelectedBounds.find((item) => item.screenId === screenId)
                  ?.bounds ?? undefined
              );
            }}
          />
        </Show>
      </Transition>
    </div>
  );
}
