import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import { makePersisted } from "@solid-primitives/storage";
import { createStore } from "solid-js/store";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";

import { commands } from "../utils/tauri";
import { createCameraForLabel } from "../utils/media";
import { makeInvalidated } from "../utils/events";
import { CloseX, Expand, Flip, Minimize, Squircle } from "../icons";

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
  const [options] = makeInvalidated(
    createResource(async () => {
      const o = await commands.getRecordingOptions();
      if (o.status === "ok") return o.data;
    }),
    "recordingOptionsChanged"
  );

  const camera = createCameraForLabel(() => options()?.cameraLabel ?? "");

  const [cameraStream] = createResource(
    () => camera()?.deviceId,
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

  const [state, setState] = makePersisted(
    createStore<CameraWindow.State>({
      size: "sm",
      shape: "round",
      mirrored: false,
    })
  );

  createEffect(on(() => state.size, resizeWindow));

  return (
    <Show when={options()}>
      {(options) => (
        <div
          data-tauri-drag-region
          class="cursor-move group w-screen h-screen bg-gray-200 m-0 p-0 relative overflow-hidden flex items-center justify-center outline-none focus:outline-none border-2 border-sm border-gray-300"
          style={{ "border-radius": cameraBorderRadius(state) }}
        >
          <div class="opacity-0 group-hover:opacity-100 absolute top-5 left-1/2 transform -translate-x-1/2 bg-gray-800 bg-opacity-75 backdrop-blur-sm rounded-xl z-20 grid grid-cols-4 overflow-hidden transition-opacity">
            <div
              onClick={() => {
                commands.setRecordingOptions({
                  ...options(),
                  cameraLabel: null,
                });
              }}
              class="h-full flex items-center justify-center p-2 hover:bg-gray-900"
            >
              <div>
                <CloseX class="w-5 h-5 stroke-gray-200" />
              </div>
            </div>
            <div
              onClick={() => {
                setState("size", (s) => (s === "sm" ? "lg" : "sm"));
              }}
              class="h-full flex items-center justify-center p-2 hover:bg-gray-900"
            >
              <div>
                {state.size === "sm" ? (
                  <Expand class="w-5 h-5 stroke-gray-200" />
                ) : (
                  <Minimize class="w-5 h-5 stroke-gray-200" />
                )}
              </div>
            </div>
            <div
              onClick={() =>
                setState("shape", (s) => (s === "round" ? "square" : "round"))
              }
              class="h-full flex items-center justify-center p-2 hover:bg-gray-900"
            >
              {state.shape === "round" ? (
                <div>
                  <Squircle class="w-5 h-5 stroke-gray-200" />
                </div>
              ) : (
                <span class="w-3 h-3 bg-gray-200 rounded-full" />
              )}
            </div>
            <div
              onClick={() => setState("mirrored", (m) => !m)}
              class="h-full flex items-center justify-center p-2 hover:bg-gray-900"
            >
              <div>
                <Flip class="w-5 h-5 stroke-gray-200" />
              </div>
            </div>
          </div>

          <video
            data-tauri-drag-region
            autoplay
            playsinline
            muted
            class={
              "absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
            }
            style={{ transform: state.mirrored ? "scaleX(1)" : "scaleX(-1)" }}
            ref={setCameraRef}
          />
        </div>
      )}
    </Show>
  );
}

function cameraBorderRadius(state: CameraWindow.State) {
  if (state.shape === "round") return "9999px";
  if (state.size === "sm") return "3rem";
  return "4rem";
}

async function resizeWindow(size: CameraWindow.Size) {
  const monitor = await currentMonitor();

  const windowWidth = size === "sm" ? 230 : 400;
  const windowHeight = size === "sm" ? 230 : 400;

  if (!monitor) return;

  const scalingFactor = monitor.scaleFactor;
  const x = 100;
  const y = monitor.size.height / scalingFactor - windowHeight - 100;

  console.log(scalingFactor, x, y, windowWidth, windowHeight, monitor);

  const currentWindow = getCurrentWindow();
  currentWindow.setSize(new LogicalSize(windowWidth, windowHeight));
  currentWindow.setPosition(new LogicalPosition(x / scalingFactor, y));
}
