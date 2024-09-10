import { makePersisted } from "@solid-primitives/storage";
import {
  LogicalPosition,
  LogicalSize,
  currentMonitor,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import {
  type ComponentProps,
  Show,
  Suspense,
  createEffect,
  createResource,
  createSignal,
  on,
} from "solid-js";
import { createStore } from "solid-js/store";
import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { cx } from "cva";

import { createCameraForLabel } from "../utils/media";
import { createOptionsQuery } from "../utils/queries";
import { commands } from "../utils/tauri";

namespace CameraWindow {
  export type Size = "sm" | "lg";
  export type Shape = "round" | "square";
  export type State = {
    size: Size;
    shape: Shape;
    mirrored: boolean;
  };
}

export default function () {
  const options = createOptionsQuery();

  const camera = createCameraForLabel(() => options.data?.cameraLabel ?? "");

  const [cameraPreviewRef] = createCameraPreview(() => camera()?.deviceId);

  const [state, setState] = makePersisted(
    createStore<CameraWindow.State>({
      size: "sm",
      shape: "round",
      mirrored: false,
    })
  );

  createEffect(on(() => state.size, resizeWindow));

  return (
    <Suspense fallback={<div class="w-screen h-screen bg-red-400" />}>
      <Show when={options.data}>
        {(options) => (
          <div
            data-tauri-drag-region
            class="cursor-move group w-screen h-screen relative flex flex-col"
            style={{ "border-radius": cameraBorderRadius(state) }}
          >
            <div class="h-16" data-tauri-drag-region />
            <div class="flex flex-col flex-1 relative" data-tauri-drag-region>
              <video
                data-tauri-drag-region
                autoplay
                playsinline
                muted
                class={cx(
                  "w-full h-full object-cover pointer-events-none border-none shadow-lg",
                  state.shape === "round" ? "rounded-full" : "rounded-3xl"
                )}
                style={{
                  transform: state.mirrored ? "scaleX(1)" : "scaleX(-1)",
                }}
                ref={cameraPreviewRef}
              />
              <div class="flex flex-row items-center justify-center absolute -top-14 inset-x-0">
                <div class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-500 border border-white-transparent-20 text-gray-400">
                  <ControlButton
                    onClick={() => {
                      commands.setRecordingOptions({
                        ...options(),
                        cameraLabel: null,
                      });
                    }}
                  >
                    <IconCapCircleX class="size-5.5" />
                  </ControlButton>
                  <ControlButton
                    pressed={state.size === "lg"}
                    onClick={() => {
                      setState("size", (s) => (s === "sm" ? "lg" : "sm"));
                    }}
                  >
                    <IconCapEnlarge class="size-5.5" />
                  </ControlButton>
                  <ControlButton
                    pressed={state.shape === "square"}
                    onClick={() =>
                      setState("shape", (s) =>
                        s === "round" ? "square" : "round"
                      )
                    }
                  >
                    <IconCapSquare class="size-5.5" />
                  </ControlButton>
                  <ControlButton
                    pressed={state.mirrored}
                    onClick={() => setState("mirrored", (m) => !m)}
                  >
                    <IconCapArrows class="size-5.5" />
                  </ControlButton>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Suspense>
  );
}

function cameraBorderRadius(state: CameraWindow.State) {
  if (state.shape === "round") return "9999px";
  if (state.size === "sm") return "3rem";
  return "4rem";
}

const BAR_HEIGHT = 56;
async function resizeWindow(size: CameraWindow.Size) {
  const monitor = await currentMonitor();

  const windowWidth = size === "sm" ? 230 : 400;
  const windowHeight = windowWidth + BAR_HEIGHT;

  if (!monitor) return;

  const scalingFactor = monitor.scaleFactor;
  const x = monitor.size.width / scalingFactor - windowWidth - 100;
  const y = monitor.size.height / scalingFactor - windowHeight - 100;

  const currentWindow = getCurrentWindow();
  currentWindow.setSize(new LogicalSize(windowWidth, windowHeight));
  currentWindow.setPosition(new LogicalPosition(x, y));
}

function createCameraPreview(deviceId: () => string | undefined) {
  const [cameraStream] = createResource(
    deviceId,

    (cameraInputId) =>
      navigator.mediaDevices.getUserMedia({
        video: { deviceId: cameraInputId },
      })
  );

  const [cameraRef, setCameraRef] = createSignal<HTMLVideoElement>();

  createEffect(() => {
    const stream = cameraStream();
    const ref = cameraRef();

    if (ref && stream) {
      if (ref.srcObject === stream) return;
      ref.srcObject = stream;
      ref.play();
    }
  });

  return [setCameraRef] as const;
}

// {
//   "title": "Cap Permissions",
//   "label": "permissions",
//   "width": 400,
//   "height": 400,
//   "decorations": false,
//   "resizable": false,
//   "maximized": false,
//   "shadow": true,
//   "transparent": true,
//   "acceptFirstMouse": true,
//   "url": "/permissions-macos"
// }

function ControlButton(
  props: Omit<ComponentProps<typeof KToggleButton>, "type" | "class"> & {
    active?: boolean;
  }
) {
  return (
    <KToggleButton
      type="button"
      class="p-2 ui-pressed:bg-white-transparent-5 ui-pressed:text-gray-50 rounded-lg"
      {...props}
    />
  );
}
