import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { makePersisted } from "@solid-primitives/storage";
import { type } from "@tauri-apps/plugin-os";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { cx } from "cva";
import {
  type Accessor,
  type ComponentProps,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCameraMutation } from "~/utils/queries";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import { commands, events } from "~/utils/tauri";
import {
  RecordingOptionsProvider,
  useRecordingOptions,
} from "./(window-chrome)/OptionsContext";

type CameraWindowShape = "round" | "square" | "full";
type CameraWindowState = {
  size: number;
  shape: CameraWindowShape;
  mirrored: boolean;
};

const CAMERA_MIN_SIZE = 150;
const CAMERA_MAX_SIZE = 600;
const CAMERA_DEFAULT_SIZE = 230;
const CAMERA_PRESET_SMALL = 230;
const CAMERA_PRESET_LARGE = 400;

export default function () {
  document.documentElement.classList.toggle("dark", true);

  const generalSettings = generalSettingsStore.createQuery();
  const isNativePreviewEnabled =
    (type() !== "windows" && generalSettings.data?.enableNativeCameraPreview) ||
    false;

  const [cameraDisconnected, setCameraDisconnected] = createSignal(false);

  createTauriEventListener(events.recordingEvent, (payload) => {
    if (payload.variant === "InputLost" && payload.input === "camera") {
      setCameraDisconnected(true);
    } else if (
      payload.variant === "InputRestored" &&
      payload.input === "camera"
    ) {
      setCameraDisconnected(false);
    }
  });

  return (
    <RecordingOptionsProvider>
      <Show
        when={isNativePreviewEnabled}
        fallback={<LegacyCameraPreviewPage disconnected={cameraDisconnected} />}
      >
        <NativeCameraPreviewPage disconnected={cameraDisconnected} />
      </Show>
    </RecordingOptionsProvider>
  );
}

function NativeCameraPreviewPage(props: { disconnected: Accessor<boolean> }) {
  const [state, setState] = makePersisted(
    createStore<CameraWindowState>({
      size: CAMERA_DEFAULT_SIZE,
      shape: "round",
      mirrored: false,
    }),
    { name: "cameraWindowState" }
  );

  const [isResizing, setIsResizing] = createSignal(false);
  const [resizeStart, setResizeStart] = createSignal({
    size: 0,
    x: 0,
    y: 0,
    corner: "",
  });

  createEffect(() => {
    const clampedSize = Math.max(
      CAMERA_MIN_SIZE,
      Math.min(CAMERA_MAX_SIZE, state.size)
    );
    if (clampedSize !== state.size) {
      setState("size", clampedSize);
    }
    commands.setCameraPreviewState(state);
  });

  const [cameraPreviewReady] = createResource(() =>
    commands.awaitCameraPreviewReady()
  );

  const setCamera = createCameraMutation();

  const scale = () => {
    const normalized =
      (state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
    return 0.7 + normalized * 0.3;
  };

  const handleResizeStart = (corner: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    setResizeStart({ size: state.size, x: e.clientX, y: e.clientY, corner });
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!isResizing()) return;
    const start = resizeStart();
    const deltaX = e.clientX - start.x;
    const deltaY = e.clientY - start.y;

    let delta = 0;
    if (start.corner.includes("e") && start.corner.includes("s")) {
      delta = Math.max(deltaX, deltaY);
    } else if (start.corner.includes("e") && start.corner.includes("n")) {
      delta = Math.max(deltaX, -deltaY);
    } else if (start.corner.includes("w") && start.corner.includes("s")) {
      delta = Math.max(-deltaX, deltaY);
    } else if (start.corner.includes("w") && start.corner.includes("n")) {
      delta = Math.max(-deltaX, -deltaY);
    } else if (start.corner.includes("e")) {
      delta = deltaX;
    } else if (start.corner.includes("w")) {
      delta = -deltaX;
    } else if (start.corner.includes("s")) {
      delta = deltaY;
    } else if (start.corner.includes("n")) {
      delta = -deltaY;
    }

    const newSize = Math.max(
      CAMERA_MIN_SIZE,
      Math.min(CAMERA_MAX_SIZE, start.size + delta)
    );
    setState("size", newSize);
  };

  const handleResizeEnd = () => {
    setIsResizing(false);
  };

  createEffect(() => {
    if (isResizing()) {
      window.addEventListener("mousemove", handleResizeMove);
      window.addEventListener("mouseup", handleResizeEnd);
      onCleanup(() => {
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeEnd);
      });
    }
  });

  return (
    <div
      data-tauri-drag-region
      class="flex relative flex-col w-screen h-screen cursor-move group"
    >
      <Show when={props.disconnected()}>
        <CameraDisconnectedOverlay />
      </Show>
      <div class="h-13">
        <div class="flex flex-row justify-center items-center">
          <div
            class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10"
            style={{ transform: `scale(${scale()})` }}
          >
            <ControlButton onClick={() => getCurrentWindow().close()}>
              <IconCapCircleX class="size-5.5" />
            </ControlButton>
            <ControlButton
              pressed={state.size >= CAMERA_PRESET_LARGE}
              onClick={() => {
                setState(
                  "size",
                  state.size < CAMERA_PRESET_LARGE
                    ? CAMERA_PRESET_LARGE
                    : CAMERA_PRESET_SMALL
                );
              }}
            >
              <IconCapEnlarge class="size-5.5" />
            </ControlButton>
            <ControlButton
              pressed={state.shape !== "round"}
              onClick={() =>
                setState("shape", (s) =>
                  s === "round" ? "square" : s === "square" ? "full" : "round"
                )
              }
            >
              {state.shape === "round" && <IconCapCircle class="size-5.5" />}
              {state.shape === "square" && <IconCapSquare class="size-5.5" />}
              {state.shape === "full" && (
                <IconLucideRectangleHorizontal class="size-5.5" />
              )}
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
        class="absolute top-0 left-0 w-4 h-4 cursor-nw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("nw")}
      />
      <div
        class="absolute top-0 right-0 w-4 h-4 cursor-ne-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("ne")}
      />
      <div
        class="absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("sw")}
      />
      <div
        class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("se")}
      />

      {/* The camera preview is rendered in Rust by wgpu */}
      <Show when={cameraPreviewReady.loading}>
        <div class="w-full flex-1 flex items-center justify-center">
          <div class="text-gray-11">Loading camera...</div>
        </div>
      </Show>
    </div>
  );
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

// Legacy stuff below

function LegacyCameraPreviewPage(props: { disconnected: Accessor<boolean> }) {
  const { rawOptions } = useRecordingOptions();

  const [state, setState] = makePersisted(
    createStore<CameraWindowState>({
      size: CAMERA_DEFAULT_SIZE,
      shape: "round",
      mirrored: false,
    }),
    { name: "cameraWindowState" }
  );

  const [isResizing, setIsResizing] = createSignal(false);
  const [resizeStart, setResizeStart] = createSignal({
    size: 0,
    x: 0,
    y: 0,
    corner: "",
  });

  const [latestFrame, setLatestFrame] = createLazySignal<{
    width: number;
    data: ImageData;
  } | null>();

  const [frameDimensions, setFrameDimensions] = createSignal<{
    width: number;
    height: number;
  } | null>(null);

  function imageDataHandler(imageData: { width: number; data: ImageData }) {
    setLatestFrame(imageData);

    const currentDimensions = frameDimensions();
    if (
      !currentDimensions ||
      currentDimensions.width !== imageData.data.width ||
      currentDimensions.height !== imageData.data.height
    ) {
      setFrameDimensions({
        width: imageData.data.width,
        height: imageData.data.height,
      });
    }

    const ctx = cameraCanvasRef?.getContext("2d");
    ctx?.putImageData(imageData.data, 0, 0);
  }

  const { cameraWsPort } = (window as any).__CAP__;
  const [ws, isConnected] = createImageDataWS(
    `ws://localhost:${cameraWsPort}`,
    imageDataHandler
  );

  const reconnectInterval = setInterval(() => {
    if (!isConnected()) {
      console.log("Attempting to reconnect...");
      ws.close();

      const newWs = createImageDataWS(
        `ws://localhost:${cameraWsPort}`,
        imageDataHandler
      );
      Object.assign(ws, newWs[0]);
    }
  }, 5000);

  onCleanup(() => {
    clearInterval(reconnectInterval);
    ws.close();
  });

  const scale = () => {
    const normalized =
      (state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
    return 0.7 + normalized * 0.3;
  };

  const handleResizeStart = (corner: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    setResizeStart({ size: state.size, x: e.clientX, y: e.clientY, corner });
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!isResizing()) return;
    const start = resizeStart();
    const deltaX = e.clientX - start.x;
    const deltaY = e.clientY - start.y;

    let delta = 0;
    if (start.corner.includes("e") && start.corner.includes("s")) {
      delta = Math.max(deltaX, deltaY);
    } else if (start.corner.includes("e") && start.corner.includes("n")) {
      delta = Math.max(deltaX, -deltaY);
    } else if (start.corner.includes("w") && start.corner.includes("s")) {
      delta = Math.max(-deltaX, deltaY);
    } else if (start.corner.includes("w") && start.corner.includes("n")) {
      delta = Math.max(-deltaX, -deltaY);
    } else if (start.corner.includes("e")) {
      delta = deltaX;
    } else if (start.corner.includes("w")) {
      delta = -deltaX;
    } else if (start.corner.includes("s")) {
      delta = deltaY;
    } else if (start.corner.includes("n")) {
      delta = -deltaY;
    }

    const newSize = Math.max(
      CAMERA_MIN_SIZE,
      Math.min(CAMERA_MAX_SIZE, start.size + delta)
    );
    setState("size", newSize);
  };

  const handleResizeEnd = () => {
    setIsResizing(false);
  };

  createEffect(() => {
    if (isResizing()) {
      window.addEventListener("mousemove", handleResizeMove);
      window.addEventListener("mouseup", handleResizeEnd);
      onCleanup(() => {
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeEnd);
      });
    }
  });

  const [windowSize] = createResource(
    () =>
      [
        state.size,
        state.shape,
        frameDimensions()?.width,
        frameDimensions()?.height,
      ] as const,
    async ([size, shape, frameWidth, frameHeight]) => {
      const monitor = await currentMonitor();

      const BAR_HEIGHT = 56;
      const base = Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, size));
      const aspect = frameWidth && frameHeight ? frameWidth / frameHeight : 1;
      const windowWidth =
        shape === "full" ? (aspect >= 1 ? base * aspect : base) : base;
      const windowHeight =
        shape === "full" ? (aspect >= 1 ? base : base / aspect) : base;
      const totalHeight = windowHeight + BAR_HEIGHT;

      if (!monitor) return;

      const scalingFactor = monitor.scaleFactor;
      const width = monitor.size.width / scalingFactor - windowWidth - 100;
      const height = monitor.size.height / scalingFactor - totalHeight - 100;

      const currentWindow = getCurrentWindow();
      currentWindow.setSize(new LogicalSize(windowWidth, totalHeight));
      currentWindow.setPosition(
        new LogicalPosition(
          width + monitor.position.toLogical(scalingFactor).x,
          height + monitor.position.toLogical(scalingFactor).y
        )
      );

      return { width, height, size: base, windowWidth, windowHeight };
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

  onMount(() => getCurrentWindow().show());

  return (
    <div
      data-tauri-drag-region
      class="flex relative flex-col w-screen h-screen cursor-move group"
      style={{ "border-radius": cameraBorderRadius(state) }}
    >
      <Show when={props.disconnected()}>
        <CameraDisconnectedOverlay />
      </Show>
      <div class="h-14">
        <div class="flex flex-row justify-center items-center">
          <div
            class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10"
            style={{ transform: `scale(${scale()})` }}
          >
            <ControlButton onClick={() => getCurrentWindow().close()}>
              <IconCapCircleX class="size-5.5" />
            </ControlButton>
            <ControlButton
              pressed={state.size >= CAMERA_PRESET_LARGE}
              onClick={() => {
                setState(
                  "size",
                  state.size < CAMERA_PRESET_LARGE
                    ? CAMERA_PRESET_LARGE
                    : CAMERA_PRESET_SMALL
                );
              }}
            >
              <IconCapEnlarge class="size-5.5" />
            </ControlButton>
            <ControlButton
              pressed={state.shape !== "round"}
              onClick={() =>
                setState("shape", (s) =>
                  s === "round" ? "square" : s === "square" ? "full" : "round"
                )
              }
            >
              {state.shape === "round" && <IconCapCircle class="size-5.5" />}
              {state.shape === "square" && <IconCapSquare class="size-5.5" />}
              {state.shape === "full" && (
                <IconLucideRectangleHorizontal class="size-5.5" />
              )}
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
        class="absolute top-0 left-0 w-4 h-4 cursor-nw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("nw")}
      />
      <div
        class="absolute top-0 right-0 w-4 h-4 cursor-ne-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("ne")}
      />
      <div
        class="absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("sw")}
      />
      <div
        class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ "pointer-events": "auto" }}
        onMouseDown={handleResizeStart("se")}
      />
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

                // Use state.size directly for immediate feedback
                const base = state.size;

                // Replicate window size logic synchronously for the canvas
                const winWidth =
                  state.shape === "full"
                    ? aspectRatio >= 1
                      ? base * aspectRatio
                      : base
                    : base;
                const winHeight =
                  state.shape === "full"
                    ? aspectRatio >= 1
                      ? base
                      : base / aspectRatio
                    : base;

                if (state.shape === "full") {
                  return {
                    width: `${winWidth}px`,
                    height: `${winHeight}px`,
                    transform: state.mirrored ? "scaleX(-1)" : "scaleX(1)",
                  };
                }

                const size = (() => {
                  if (aspectRatio > 1)
                    return {
                      width: base * aspectRatio,
                      height: base,
                    };
                  else
                    return {
                      width: base,
                      height: base * aspectRatio,
                    };
                })();

                const left = aspectRatio > 1 ? (size.width - base) / 2 : 0;
                const top = aspectRatio > 1 ? 0 : (base - size.height) / 2;

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

function cameraBorderRadius(state: CameraWindowState) {
  if (state.shape === "round") return "9999px";
  const normalized =
    (state.size - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
  const radius = 3 + normalized * 1.5;
  return `${radius}rem`;
}

function CameraDisconnectedOverlay() {
  return (
    <div
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm px-4 pointer-events-none"
      style={{ "border-radius": "inherit" }}
    >
      <p class="text-center text-sm font-medium text-white/90">
        Camera disconnected
      </p>
    </div>
  );
}
