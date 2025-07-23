import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { makePersisted } from "@solid-primitives/storage";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type ComponentProps,
  createEffect,
  createResource,
  on,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";

import { createCameraMutation } from "~/utils/queries";
import {
  RecordingOptionsProvider,
  useRecordingOptions,
} from "./(window-chrome)/OptionsContext";
import { commands } from "~/utils/tauri";

namespace CameraWindow {
  export type Size = "sm" | "lg";
  export type Shape = "round" | "square" | "full";
  export type State = {
    size: Size;
    shape: Shape;
    mirrored: boolean;
  };
}

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

  createEffect(() => commands.setCameraPreviewState(state));

  const [cameraPreviewReady] = createResource(() =>
    commands.awaitCameraPreviewReady()
  );

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
    >
      <div class="h-13">
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
