import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { createMemo, createSignal, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Transition } from "solid-transition-group";
import { createOptionsQuery } from "~/utils/queries";
import Cropper, {
  COMMON_RATIOS,
  CROP_ZERO,
  type CropBounds,
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
import { createScheduled, debounce } from "@solid-primitives/scheduled";
import { createTauriEventUnlisten } from "~/utils/createEventListener";

const MIN_SIZE = { width: 50, height: 50 };

export default function CaptureArea() {
  let cropperRef: CropperRef | undefined;

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
    webview.emitTo("main", "captureAreaPending", pending);

  setPendingState(true);

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

  createEventListener(window, "keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter") handleConfirm();
  });

  createTauriEventUnlisten(
    webview.onCloseRequested(() => setPendingState(false))
  );

  function reset() {
    cropperRef?.reset();
    setAspect(null);

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

  const [aspect, setAspect] = createSignal<Ratio | null>(null);

  async function showMenu(e: MouseEvent) {
    e.preventDefault();
    const targetRect = (e.target as HTMLDivElement).getBoundingClientRect();

    const items = [
      {
        text: "Free",
        checked: !aspect(),
        action: () => setAspect(null),
      } satisfies CheckMenuItemOptions,
      ...COMMON_RATIOS.map(
        (ratio) =>
          ({
            text: `${ratio[0]}:${ratio[1]}`,
            checked: aspect() === ratio,
            action: () => setAspect(ratio),
          } satisfies CheckMenuItemOptions)
      ),
      { item: "Separator" } satisfies PredefinedMenuItemOptions,
      {
        text: "Snap to ratios",
        checked: persistedState.snapToRatio,
        action: () => setPersistedState("snapToRatio", (v) => !v),
      } satisfies CheckMenuItemOptions,
    ];

    const menu = await Menu.new({ items });
    await menu.popup(new LogicalPosition(targetRect.x, targetRect.y + 50));
    await menu.close();
  }

  return (
    <div class="overflow-hidden w-screen h-screen fixed">
      <div class="flex fixed z-50 justify-center items-center w-full">
        <Transition
          appear
          enterClass="-translate-y-5 scale-75 opacity-0 blur-lg"
          enterActiveClass="duration-500 [transition-timing-function:cubic-bezier(0.175,0.885,0.12,1.175)]"
          enterToClass="translate-y-0 scale-100 opacity-100"
          exitClass="translate-y-0 scale-100 opacity-100"
          exitActiveClass="duration-500 [transition-timing-function:cubic-bezier(0.275,0.05,0.22,1.3)]"
          exitToClass="-translate-y-5 scale-75 opacity-0 blur-lg"
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
                    onMouseDown={showMenu}
                    onClick={showMenu}
                  >
                    <div class="relative size-5">
                      <Show when={!aspect()}>
                        <IconLucideRatio class="group-active:scale-90 transition-transform size-5 pointer-events-none *:pointer-events-none" />
                      </Show>
                      <Transition
                        enterClass="scale-50 opacity-0 blur-md"
                        enterActiveClass="duration-200 [transition-timing-function:cubic-bezier(0.215,0.61,0.355,1)]"
                        enterToClass="scale-100 opacity-100 blur-0"
                        exitClass="opacity-0"
                        exitActiveClass="duration-0"
                        exitToClass="opacity-0"
                      >
                        <Show when={aspect()} keyed>
                          {(ratio) => (
                            <span class="absolute inset-0 flex items-center justify-center text-[13px] text font-medium leading-none tracking-tight text-blue-10 pointer-events-none">
                              {ratio[0]}:{ratio[1]}
                            </span>
                          )}
                        </Show>
                      </Transition>
                    </div>
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
            aspectRatio={aspect() ?? undefined}
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
            // WKWebView with `drawsBackground: no`, correctly applies filters and it even has
            //  access to the display's frame buffer for applying it on stuff behind the view,
            //  but it only lasts for about 5 seconds before it disappears :c
            disableBackdropFilters={true}
          />
        </Show>
      </Transition>
    </div>
  );
}
