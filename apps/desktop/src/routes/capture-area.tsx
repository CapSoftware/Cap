import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Cropper from "~/components/Cropper";
import { createStore } from "solid-js/store";
import { type Crop } from "~/utils/tauri";
import { makePersisted } from "@solid-primitives/storage";
import { Tooltip } from "@kobalte/core";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { Transition } from "solid-transition-group";

export default function CaptureArea() {
  const { options, setOptions } = createOptionsQuery();
  const webview = getCurrentWebviewWindow();

  const [state, setState] = makePersisted(createStore({
    showGrid: true,
  }), { name: "captureArea" });

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
    const target = options.data?.captureTarget;
    if (!options.data || !target || target.variant !== "screen") return;
    setPendingState(false);

    setOptions.mutate({
      ...options.data,
      captureTarget: {
        variant: "area",
        screen: target,
        bounds: {
          x: crop.position.x,
          y: crop.position.y,
          width: crop.size.x,
          height: crop.size.y,
        },
      },
    });

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
    <div class="w-screen h-screen overflow-hidden bg-black bg-opacity-25">
      <div class="fixed w-full z-50 flex items-center justify-center">
        <Transition
          appear
          enterActiveClass="fade-in animate-in slide-in-from-top-6"
          exitActiveClass="fade-out animate-out slide-out-to-top-6"
        >
          <Show when={visible()}>
            <div class="transition-all ease-out duration-300 absolute w-auto h-10 bg-gray-50 rounded-[12px] drop-shadow-2xl overflow-visible border border-gray-50 dark:border-gray-300 outline outline-1 outline-[#dedede] dark:outline-[#000] flex justify-around p-1 top-11">
              <button
                class="py-[0.25rem] px-2 text-gray-400 gap-[0.25rem] flex flex-row items-center rounded-[8px] ml-0 right-auto"
                type="button"
                onClick={close}
              >
                <IconCapCircleX class="size-5" />
              </button>
              <Tooltip.Root openDelay={500}>
                <Tooltip.Trigger tabIndex={-1}>
                  <button
                    class={`py-[0.25rem] px-2 gap-[0.25rem] mr-2 hover:bg-gray-200 flex flex-row items-center rounded-[8px] transition-colors duration-200 ${state.showGrid ? "bg-gray-200 text-blue-300" : "text-gray-500 opacity-50"}`}
                    type="button"
                    onClick={() => setState("showGrid", (v) => !v)}
                  >
                    <IconCapPadding class="size-5" />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in delay-1000 duration-500">
                    Rule of Thirds
                    <Tooltip.Arrow class="fill-gray-500" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
              <div class="flex flex-row flex-grow justify-center gap-2">
                <button
                  class="text-blue-300 px-2 dark:text-blue-300 gap-[0.25rem] hover:bg-blue-50 flex flex-row items-center rounded-[8px] grow justify-center transition-colors duration-200"
                  type="button"
                  onClick={handleConfirm}
                >
                  <IconCapCircleCheck class="size-5" />
                  <span class="font-[500] text-[0.875rem]">Confirm selection</span>
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
            class="transition-all duration-300"
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
