import { createEventListenerMap } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import { createQuery } from "@tanstack/solid-query";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Transition } from "solid-transition-group";
import Cropper from "~/components/Cropper";
import { createOptionsQuery, listScreens } from "~/utils/queries";
import { type Crop } from "~/utils/tauri";

export default function CaptureArea() {
  const { options, setOptions } = createOptionsQuery();
  const webview = getCurrentWebviewWindow();

  const [state, setState] = makePersisted(
    createStore({
      showGrid: true,
    }),
    { name: "captureArea" }
  );

  const setPendingState = (pending: boolean) =>
    webview.emitTo(
      "main-new",
      "cap-window://capture-area/state/pending",
      pending
    );

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

  const [crop, setCrop] = makePersisted(
    createStore<Crop>({
      position: { x: 0, y: 0 },
      size: { x: 0, y: 0 },
    }),
    { name: "crop" }
  );

  const screens = createQuery(() => listScreens);

  async function handleConfirm() {
    // Exit if no options data
    if (!options.data) return;

    // Get screen
    let screenTarget = screens.data?.[0];

    // Still no screen target, can't proceed
    if (!screenTarget) return;

    setPendingState(false);

    setOptions.mutate({
      ...options.data,
      captureTarget: {
        variant: "area",
        screen: screenTarget.id,
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
      (await WebviewWindow.getByLabel("main-new"))?.unminimize();
      setPendingState(false);
      webview.close();
    }, 250);
  }

  return (
    <div class="overflow-hidden w-screen h-screen bg-black/25">
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
