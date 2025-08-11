import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import {
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Transition } from "solid-transition-group";
import { createOptionsQuery } from "~/utils/queries";
import Cropper, {
  COMMON_RATIOS,
  CROP_ZERO,
  CropBounds,
  type CropperRef,
  type Ratio,
} from "~/components/Cropper";
import { type as ostype } from "@tauri-apps/plugin-os";
import {
  type CheckMenuItemOptions,
  type PredefinedMenuItemOptions,
  CheckMenuItem,
  Menu,
  PredefinedMenuItem,
} from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { createWindowSize } from "@solid-primitives/resize-observer";
import { createScheduled, debounce } from "@solid-primitives/scheduled";

const MIN_SIZE = { width: 50, height: 50 };

const MENU_ID_ASPECT_NONE = "crop-options-aspect-none";
const MENU_ID_SNAPPING_ENABLED = "crop-options-snapping";

function getMenuIdForRatio(ratio: Ratio) {
  return `crop-options-aspect-${ratio[0]}-${ratio[1]}`;
}

export default function CaptureArea() {
  let cropperRef: CropperRef | undefined;
  let aspectMenu: Menu | undefined;

  const [crop, setCrop] = createSignal(CROP_ZERO);

  const scheduled = createScheduled((fn) => debounce(fn, 50));

  const isValid = createMemo((p: boolean = true) => {
    const b = crop();
    return scheduled()
      ? b.width >= MIN_SIZE.width && b.height >= MIN_SIZE.height
      : p;
  });

  const { rawOptions, setOptions } = createOptionsQuery();
  const webview = getCurrentWebviewWindow();

  const setPendingState = (pending: boolean) =>
    webview.emitTo("main", "cap-window://capture-area/state/pending", pending);

  const screenId =
    rawOptions.captureTarget.variant === "screen"
      ? rawOptions.captureTarget.id
      : null;

  const [persistedState, setPersistedState] = makePersisted(
    createStore<{
      snapToRatio: boolean;
      lastSelectedBounds: { screenId: number; bounds: CropBounds }[];
    }>({ snapToRatio: true, lastSelectedBounds: [] }),
    {
      name: "capture-area-state",
    }
  );

  const windowSize = createWindowSize();

  onMount(async () => {
    setPendingState(true);
    const unlisten = await webview.onCloseRequested(() =>
      setPendingState(false)
    );

    createEventListener(window, "keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter") handleConfirm();
    });

    // const items = await Promise.all([
    //   CheckMenuItem.new({
    //     id: MENU_ID_ASPECT_NONE,
    //     text: "Free",
    //     // checked: !aspectState.selectedRatio,
    //     // action: () => setAspectState("selectedRatio", null),
    //   }),
    //   ...COMMON_RATIOS.map((ratio) =>
    //     CheckMenuItem.new({
    //       id: getMenuIdForRatio(ratio),
    //       text: `${ratio[0]}:${ratio[1]}`,
    //       // checked: ratiosEqual(aspectState.selectedRatio, ratio),
    //       // action: () => setAspectState("selectedRatio", ratio),
    //     })
    //   ),
    //   PredefinedMenuItem.new({ item: "Separator" }),
    //   CheckMenuItem.new({
    //     id: MENU_ID_SNAPPING_ENABLED,
    //     text: "Snapping enabled",
    //     checked: persistedState.snapToRatio,
    //     action: () => setPersistedState("snapToRatio", (v) => !v),
    //   }),
    // ]);

    // Menu.new({
    //   // id: "crop-options",
    //   items,
    // });

    createEventListener(window, "beforeunload", () => {
      // if (aspectMenu) aspectMenu.close();
    });

    onCleanup(() => {
      unlisten();
      // if (aspectMenu) aspectMenu.close();
    });
  });

  function reset() {
    cropperRef?.reset();
    if (!screenId) return;
    setPersistedState("lastSelectedBounds", (values) =>
      values.filter((v) => v.screenId !== screenId)
    );
  }

  async function handleConfirm() {
    const currentBounds = cropperRef?.bounds();
    if (!currentBounds) throw new Error("Cropper not initialized");
    if (
      currentBounds.width < MIN_SIZE.width ||
      currentBounds.height < MIN_SIZE.height
    )
      return;

    const target = rawOptions.captureTarget;
    if (target.variant !== "screen") return;
    setPendingState(false);

    // Store the bounds for this screen
    if (screenId) {
      const existingIndex = persistedState.lastSelectedBounds.findIndex(
        (item) => item.screenId === screenId
      );
      if (existingIndex >= 0) {
        setPersistedState("lastSelectedBounds", existingIndex, {
          screenId,
          bounds: currentBounds,
        });
      } else {
        setPersistedState("lastSelectedBounds", [
          ...persistedState.lastSelectedBounds,
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

  function ratiosEqual(a: Ratio | null, b: Ratio): boolean {
    return a?.[0] === b[0] && a?.[1] === b[1];
  }

  async function aspectRatioMenu(e: MouseEvent) {
    if (!aspectMenu) return;
    e.preventDefault();
    const targetRect = (e.target as HTMLDivElement).getBoundingClientRect();
    aspectMenu.popup(new LogicalPosition(targetRect.x, targetRect.y + 50));
  }

  return (
    <div class="overflow-hidden w-screen h-screen">
      <div class="flex fixed z-50 justify-center items-center w-full">
        <Transition
          appear
          enterClass="-translate-y-8 scale-75 opacity-0"
          enterActiveClass="duration-500 [transition-timing-function:cubic-bezier(0.275,0.05,0.22,1.3)]"
          enterToClass="translate-y-0 scale-100 opacity-100"
          exitClass="translate-y-0 scale-100 opacity-100"
          exitActiveClass="duration-500 [transition-timing-function:cubic-bezier(0.275,0.05,0.22,1.3)]"
          exitToClass="-translate-y-8 scale-75 opacity-0"
        >
          <Show when={visible()}>
            <div
              class="scale-100 flex items-center p-1 gap-2 absolute w-auto h-14 rounded-full top-12"
              classList={{ "flex-row-reverse": ostype() === "windows" }}
            >
              <button
                title="Close"
                class="group flex items-center justify-center size-12 text-gray-11 shadow-xl shadow-black/30 bg-gray-1 border border-gray-5 hover:bg-gray-4 active:bg-gray-6 rounded-full transition-colors duration-200 cursor-default"
                type="button"
                onClick={close}
              >
                <IconLucideX class="group-active:scale-90 transition-transform size-5 *:pointer-events-none" />
              </button>
              <div class="flex items-center h-full gap-2">
                <div class="flex items-center justify-between gap-1 px-[3px] size-full shadow-xl shadow-black/30 bg-gray-1 border border-gray-5 rounded-full">
                  <button
                    title="Reset"
                    type="button"
                    class="group flex items-center justify-center size-10 text-gray-11 hover:bg-gray-5 active:bg-gray-6 rounded-full transition-colors duration-200 cursor-default"
                    onClick={reset}
                  >
                    <IconLucideRotateCcw class="group-active:scale-90 transition-transform size-5 *:pointer-events-none" />
                  </button>
                  <div class="inline-block my-3 w-[1px] self-stretch bg-gray-3" />
                  <button
                    title="Fill"
                    class="group flex items-center justify-center size-10 text-gray-11 hover:bg-gray-5 active:bg-gray-6 rounded-full transition-colors duration-200 cursor-default"
                    type="button"
                    onClick={() => cropperRef?.fill()}
                  >
                    <IconLucideExpand class="group-active:scale-90 transition-transform size-5 *:pointer-events-none" />
                  </button>
                  <div class="inline-block my-3 w-[1px] self-stretch bg-gray-3" />
                  <button
                    title="Aspect Ratio"
                    class="group flex items-center justify-center size-10 text-gray-11 hover:bg-gray-5 active:bg-gray-6 rounded-full transition-colors duration-200 cursor-default"
                    type="button"
                    onMouseDown={aspectRatioMenu}
                    onClick={aspectRatioMenu}
                  >
                    <IconLucideRatio class="group-active:scale-90 transition-transform size-5 pointer-events-none *:pointer-events-none" />
                  </button>
                </div>

                <div class="h-full transition-all duration-300 ease-out">
                  <button
                    class="group flex items-center justify-center px-3 h-full min-w-28 border border-gray-5 rounded-full gap-2 text-blue-10 bg-gray-1 shadow-xl shadow-black/30 duration-200 enabled:hover:bg-blue-2 enabled:hover:border-blue-5 enabled:active:bg-blue-3 disabled:opacity-90 disabled:cursor-not-allowed disabled:bg-gray-3 disabled:border-gray-4 cursor-default"
                    type="button"
                    disabled={!isValid()}
                    onClick={handleConfirm}
                  >
                    <div class="group-active:scale-95 transition-transform flex gap-2">
                      <IconLucideCheck class="size-5 *:pointer-events-none" />
                      <span class="font-medium text-sm">Confirm</span>
                    </div>
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
          <Cropper
            ref={cropperRef}
            // aspectRatio={[16, 9]}
            showBounds={true}
            onCropChange={setCrop}
            snapToRatioEnabled={persistedState.snapToRatio}
            initialCrop={() =>
              screenId
                ? persistedState.lastSelectedBounds.find(
                    (m) => m.screenId === screenId
                  )?.bounds
                : undefined
            }
          />
        </Show>
      </Transition>
    </div>
  );
}
