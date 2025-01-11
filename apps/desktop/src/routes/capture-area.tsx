import { createSignal, onCleanup, onMount } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Cropper from "~/components/Cropper";
import { createStore } from "solid-js/store";
import { Crop } from "~/utils/tauri";

export default function CaptureArea() {
  const { options, setOptions } = createOptionsQuery();
  const webview = getCurrentWebviewWindow();

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
    window.addEventListener("resize", handleResize);
    onCleanup(() => window.removeEventListener("resize", handleResize));
  });

  const [crop, setCrop] = createStore<Crop>({
    size: { x: 0, y: 0 },
    position: { x: 0, y: 0 },
  });

  function handleConfirm() {
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
  }

  function handleDiscard() {
    setPendingState(false);
    webview.close();
  }

  return (
    <div class="w-screen h-screen overflow-hidden bg-black bg-opacity-25">
      <div class="fixed w-full z-50 flex items-center justify-center">
        <div class="absolute w-[30rem] h-12 bg-gray-50 rounded-lg drop-shadow-2xl border border-1 border-gray-100 flex flex-row-reverse justify-around gap-3 p-1 *:transition-all *:duration-200 top-10">
          <div class="flex flex-row">
            <button
              class="py-[0.25rem] px-[0.5rem] text-red-300 dark:red-blue-300 gap-[0.25rem] hover:bg-red-50 flex flex-row items-center rounded-lg"
              type="button"
              onClick={handleDiscard}
            >
              <IconCapCircleX class="size-5" />
              <span class="font-[500] text-[0.875rem]">Discard</span>
            </button>
            <button
              class="py-[0.25rem] px-[0.5rem] text-blue-300 dark:text-blue-300 gap-[0.25rem] hover:bg-blue-50 flex flex-row items-center rounded-lg"
              type="button"
              onClick={handleConfirm}
            >
              <IconCapCircleCheck class="size-5" />
              <span class="font-[500] text-[0.875rem]">Confirm selection</span>
            </button>
          </div>
        </div>
      </div>

      <Cropper cropStore={[crop, setCrop]} showGuideLines={true} />
    </div>
  );
}
