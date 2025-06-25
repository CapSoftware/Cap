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
import Cropper from "~/components/Cropper";
import { createOptionsQuery } from "~/utils/queries";
import { type Crop } from "~/utils/tauri";

export default function CaptureArea() {
  const { rawOptions, setOptions } = createOptionsQuery();
  const webview = getCurrentWebviewWindow();

  const [state, setState] = makePersisted(
    createStore({
      showGrid: true,
    }),
    { name: "captureArea" }
  );

  const setPendingState = (pending: boolean) =>
    webview.emitTo("main", "cap-window://capture-area/state/pending", pending);

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

  const [crop, setCrop] = createStore<Crop>({
    size: { x: 0, y: 0 },
    position: { x: 0, y: 0 },
  });

  async function handleConfirm() {
    const target = rawOptions.captureTarget;
    if (target.variant !== "screen") return;
    setPendingState(false);

    setOptions(
      "captureTarget",
      reconcile({
        variant: "area",
        screen: target.id,
        bounds: {
          x: crop.position.x,
          y: crop.position.y,
          width: crop.size.x,
          height: crop.size.y,
        },
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
          enterActiveClass="fade-in animate-in slide-in-from-top-6"
          exitActiveClass="fade-out animate-out slide-out-to-top-6"
        >
          <Show when={visible()}>
            <div class="transition-all ease-out duration-200 absolute w-auto h-10 bg-gray-1 rounded-[12px] drop-shadow-2xl overflow-visible border border-gray-3 outline outline-1 outline-gray-6 flex justify-around p-1 top-11">
              <button
                class="py-[0.25rem] px-2 text-gray-11 gap-[0.25rem] flex flex-row items-center rounded-[8px] ml-0 right-auto"
                type="button"
                onClick={close}
              >
                <IconCapCircleX class="size-5" />
              </button>
              <Tooltip.Root openDelay={500}>
                <Tooltip.Trigger tabIndex={-1}>
                  <button
                    class={`py-[0.25rem] px-2 gap-[0.25rem] mr-2 hover:bg-gray-3 flex flex-row items-center rounded-[8px] transition-colors duration-200 ${
                      state.showGrid
                        ? "bg-gray-3 text-blue-9"
                        : "text-gray-12 opacity-50"
                    }`}
                    type="button"
                    onClick={() => setState("showGrid", (v) => !v)}
                  >
                    <IconCapPadding class="size-5" />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content class="z-50 px-2 py-1 text-xs rounded shadow-lg duration-500 delay-1000 text-gray-1 bg-gray-12 animate-in fade-in">
                    Rule of Thirds
                    <Tooltip.Arrow class="fill-gray-12" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
              <div class="flex flex-row flex-grow gap-2 justify-center">
                <button
                  class="text-blue-9 px-2 gap-[0.25rem] hover:bg-blue-3 flex flex-row items-center rounded-[8px] grow justify-center transition-colors duration-200"
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
          <Cropper
            class="transition-all duration-200"
            value={crop}
            onCropChange={setCrop}
            showGuideLines={state.showGrid}
            mappedSize={{ x: windowSize().x, y: windowSize().y }}
          />
        </Show>
      </Transition>
    </div>
  );
}
