import { createSignal, onCleanup, onMount } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Cropper from "~/components/Cropper";
import { createStore } from "solid-js/store";
import { type Crop } from "~/utils/tauri";
import { makePersisted } from "@solid-primitives/storage";
import { Tooltip } from "@kobalte/core";
import { createEventListenerMap } from "@solid-primitives/event-listener";

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

  // Update window size on resize
  onMount(() => {
    const handleResize = () =>
      setWindowSize({ x: window.innerWidth, y: window.innerHeight });

    createEventListenerMap(window, {
      resize: handleResize,
      keydown: (e) => {
        if (e.key === "Escape") handleDiscard();
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

    setPendingState(false);
    await close();
  }

  async function handleDiscard() {
    setPendingState(false);
    await close();
  }

  async function close() {
    (await WebviewWindow.getByLabel("main"))?.unminimize();
    webview.close();
  }

  return (
    <div class="w-screen h-screen overflow-hidden bg-black bg-opacity-25">
      <div class="fixed w-full z-50 flex items-center justify-center animate-in slide-in-from-top-4 duration-300 ease-out">
        <div class="absolute w-[16rem] h-10 bg-gray-50 rounded-[12px] drop-shadow-2xl border border-gray-50 dark:border-gray-300 outline outline-1 outline-[#dedede] dark:outline-[#000] flex justify-around p-1 *:transition-all *:duration-200 top-10">
          <button
            class="py-[0.25rem] px-[0.5rem] text-gray-400 gap-[0.25rem] flex flex-row items-center rounded-[8px] ml-0 right-auto"
            type="button"
            onClick={handleDiscard}
          >
            <IconCapCircleX class="size-5" />
          </button>
          <Tooltip.Root openDelay={500}>
            <Tooltip.Trigger tabIndex={-1}>
              <button
                class={`py-[0.25rem] px-[0.5rem] gap-[0.25rem] hover:bg-gray-200 flex flex-row items-center rounded-[8px] ${state.showGrid ? "bg-gray-200 text-blue-300" : "text-gray-500 opacity-50"}`}
                type="button"
                onClick={() => setState("showGrid", (v) => !v)}
              >
                <IconCapPadding class="size-5" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
                Rule of Thirds
                <Tooltip.Arrow class="fill-gray-500" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <div class="flex flex-row flex-grow justify-center gap-2">
            <button
              class="px-[0.5rem] text-blue-300 dark:text-blue-300 gap-[0.25rem] hover:bg-green-50 flex flex-row items-center rounded-[8px] grow justify-center"
              type="button"
              onClick={handleConfirm}
            >
              <IconCapCircleCheck class="size-5" />
              <span class="font-[500] text-[0.875rem]">Confirm selection</span>
            </button>
          </div>
        </div>
      </div>

      <Cropper
        value={crop}
        onCropChange={setCrop}
        showGuideLines={state.showGrid}
        mappedSize={{ x: windowSize().x, y: windowSize().y }}
      />
    </div>
  );
}
