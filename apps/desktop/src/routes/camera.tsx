import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { makePersisted } from "@solid-primitives/storage";
import {
  LogicalPosition,
  LogicalSize,
  currentMonitor,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import { cx } from "cva";
import {
  type ComponentProps,
  Show,
  Suspense,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { createStore } from "solid-js/store";

import { createCameraMutation } from "~/utils/queries";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import {
  RecordingOptionsProvider,
  useRecordingOptions,
} from "./(window-chrome)/OptionsContext";

namespace CameraWindow {
  export type Size = "sm" | "lg";
  export type Shape = "round" | "square";
  export type State = {
    size: Size;
    shape: Shape;
    mirrored: boolean;
  };
}

const BAR_HEIGHT = 56;

const { cameraWsPort } = (window as any).__CAP__;

export default function () {
  document.documentElement.classList.toggle("dark", true);

  return (
    <RecordingOptionsProvider>
      <Page />
    </RecordingOptionsProvider>
  );
}

function Page() {
  const { rawOptions } = useRecordingOptions();

  const [state, setState] = makePersisted(
    createStore<CameraWindow.State>({
      size: "sm",
      shape: "round",
      mirrored: false,
    }),
    { name: "cameraWindowState" }
  );

  const [latestFrame, setLatestFrame] = createLazySignal<{
    width: number;
    data: ImageData;
  } | null>();

  const [ws, isConnected] = createImageDataWS(
    `ws://localhost:${cameraWsPort}`,
    (imageData) => {
      setLatestFrame(imageData);
      const ctx = cameraCanvasRef?.getContext("2d");
      ctx?.putImageData(imageData.data, 0, 0);
    }
  );

  // Attempt to reconnect every 5 seconds if not connected
  const reconnectInterval = setInterval(() => {
    if (!isConnected()) {
      console.log("Attempting to reconnect...");
      ws.close();

      // Create a new WebSocket connection
      const newWs = createImageDataWS(
        `ws://localhost:${cameraWsPort}`,
        (imageData) => {
          setLatestFrame(imageData);
          const ctx = cameraCanvasRef?.getContext("2d");
          ctx?.putImageData(imageData.data, 0, 0);
        }
      );
      // Update the ws reference
      Object.assign(ws, newWs[0]);
    }
  }, 5000);

  onCleanup(() => {
    clearInterval(reconnectInterval);
    ws.close();
  });

  const [windowSize] = createResource(
    () => state.size,
    async (size) => {
      const monitor = await currentMonitor();

      const windowSize = size === "sm" ? 230 : 400;
      const windowHeight = windowSize + BAR_HEIGHT;

      if (!monitor) return;

      const scalingFactor = monitor.scaleFactor;
      const width = monitor.size.width / scalingFactor - windowSize - 100;
      const height = monitor.size.height / scalingFactor - windowHeight - 100;

      const currentWindow = getCurrentWindow();
      currentWindow.setSize(new LogicalSize(windowSize, windowHeight));
      currentWindow.setPosition(
        new LogicalPosition(
          width + monitor.position.toLogical(scalingFactor).x,
          height + monitor.position.toLogical(scalingFactor).y
        )
      );

      return { width, height, size: windowSize };
    }
  );

  let cameraCanvasRef: HTMLCanvasElement | undefined;

  const setCamera = createCameraMutation();

  createEffect(
    on(
      () => rawOptions.cameraLabel,
      (label) => {
        if (label === null) getCurrentWindow().close();
      },
      { defer: true }
    )
  );

  return (
    <div
      data-tauri-drag-region
      class="flex relative flex-col w-screen h-screen cursor-move group"
      style={{ "border-radius": cameraBorderRadius(state) }}
    >
      <div class="h-14">
        <div class="flex flex-row justify-center items-center">
          <div class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10">
            <ControlButton onClick={() => setCamera.mutate(null)}>
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
                setState("shape", (s) => (s === "round" ? "square" : "round"))
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
      <div
        class={cx(
          "flex flex-col flex-1 relative overflow-hidden pointer-events-none border-none shadow-lg bg-gray-1 text-gray-12",
          state.shape === "round" ? "rounded-full" : "rounded-3xl"
        )}
        data-tauri-drag-region
      >
        <Suspense fallback={<CameraLoadingState />}>
          <Show when={latestFrame()}>
            {(latestFrame) => {
              const style = () => {
                const aspectRatio =
                  latestFrame().data.width / latestFrame().data.height;

                const windowWidth = windowSize.latest?.size ?? 0;

                const size = (() => {
                  if (aspectRatio > 1)
                    return {
                      width: windowWidth * aspectRatio,
                      height: windowWidth,
                    };
                  else
                    return {
                      width: windowWidth,
                      height: windowWidth * aspectRatio,
                    };
                })();

                const left =
                  aspectRatio > 1 ? (size.width - windowWidth) / 2 : 0;
                const top =
                  aspectRatio > 1 ? 0 : (windowWidth - size.height) / 2;

                return {
                  width: `${size.width}px`,
                  height: `${size.height}px`,
                  left: `-${left}px`,
                  top: `-${top}px`,
                  transform: state.mirrored ? "scaleX(-1)" : "scaleX(1)",
                };
              };

              return (
                <canvas
                  data-tauri-drag-region
                  class={cx("absolute")}
                  style={style()}
                  width={latestFrame().data.width}
                  height={latestFrame().data.height}
                  ref={cameraCanvasRef!}
                />
              );
            }}
          </Show>
        </Suspense>
      </div>
    </div>
  );
}

function CameraLoadingState() {
  return (
    <div class="w-full flex-1 flex items-center justify-center">
      <div class="text-gray-11">Loading camera...</div>
    </div>
  );
}

function cameraBorderRadius(state: CameraWindow.State) {
  if (state.shape === "round") return "9999px";
  if (state.size === "sm") return "3rem";
  return "4rem";
}

function ControlButton(
  props: Omit<ComponentProps<typeof KToggleButton>, "type" | "class"> & {
    active?: boolean;
  }
) {
  return (
    <KToggleButton
      type="button"
      class="p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12"
      {...props}
    />
  );
}
