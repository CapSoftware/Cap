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
  onCleanup,
} from "solid-js";
import { createStore } from "solid-js/store";
import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { cx } from "cva";

import { createOptionsQuery } from "~/utils/queries";
import { createImageDataWS, createLazySignal } from "~/utils/socket";

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
  const { options, setOptions } = createOptionsQuery();

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
  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const [ws, isConnected] = createImageDataWS(
    `ws://localhost:${cameraWsPort}`,
    (imageData) => {
      setLatestFrame(imageData);
      const ctx = cameraCanvasRef?.getContext("2d");
      ctx?.putImageData(imageData.data, 0, 0);
      setIsLoading(false);
    }
  );

  createEffect(() => {
    if (!isConnected()) {
      setIsLoading(true);
      setError("Failed to connect to the camera. Please try again.");
    } else {
      setError(null);
    }
  });

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
          setIsLoading(false);
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

  return (
    <Suspense fallback={<CameraLoadingState shape={state.shape} />}>
      <Show when={options.data}>
        {(options) => (
          <div
            data-tauri-drag-region
            class="cursor-move group w-screen h-screen relative flex flex-col bg-black"
            style={{ "border-radius": cameraBorderRadius(state) }}
          >
            <div class="h-14">
              <div class="flex flex-row items-center justify-center">
                <div class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-500 border border-white-transparent-20 text-gray-400">
                  <ControlButton
                    onClick={() => {
                      setOptions.mutate({
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
            <div
              class={cx(
                "flex flex-col flex-1 relative overflow-hidden pointer-events-none border-none shadow-lg",
                state.shape === "round" ? "rounded-full" : "rounded-3xl"
              )}
              data-tauri-drag-region
            >
              <Show
                when={!isLoading() && !error()}
                fallback={
                  <div class="flex items-center justify-center h-full">
                    {error() ? (
                      <div class="text-red-500">{error()}</div>
                    ) : (
                      <div class="text-white">Loading camera...</div>
                    )}
                  </div>
                }
              >
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
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Suspense>
  );
}

function CameraLoadingState(props: { shape: CameraWindow.Shape }) {
  const [loadingText, setLoadingText] = createSignal("Camera is loading");

  createEffect(() => {
    const loadingMessages = [
      "Camera is loading",
      "Acquiring lock on camera",
      "Camera is starting",
    ];
    let index = 0;
    const interval = setInterval(() => {
      setLoadingText(loadingMessages[index]);
      index = (index + 1) % loadingMessages.length;
    }, 2000);

    onCleanup(() => clearInterval(interval));
  });

  return (
    <div class="flex flex-col w-full h-full bg-black">
      <div class="h-14" />
      <div
        class={cx(
          "w-full flex-1 bg-gray-500 flex items-center justify-center",
          props.shape === "round" ? "rounded-full" : "rounded-3xl"
        )}
      >
        <div class="text-gray-300 text-sm">{loadingText()}</div>
      </div>
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
      class="p-2 ui-pressed:bg-white-transparent-5 ui-pressed:text-gray-50 rounded-lg"
      {...props}
    />
  );
}
