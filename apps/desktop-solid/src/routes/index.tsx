import { cx } from "cva";
import { For, Show, Suspense, createSignal } from "solid-js";

import { createCameraForLabel, createCameras } from "../utils/media";
import { createOptionsQuery, createWindowsQuery } from "../utils/queries";
import { commands, events } from "../utils/tauri";

export default function () {
  const cameras = createCameras();
  const options = createOptionsQuery();
  const windows = createWindowsQuery();

  const camera = createCameraForLabel(() => options.data?.cameraLabel ?? "");

  // temporary
  const [isRecording, setIsRecording] = createSignal(false);

  events.showCapturesPanel.listen(() => {
    commands.showPreviousRecordingsWindow();
  });

  return (
    <>
      <button
        type="button"
        onClick={() => commands.showPreviousRecordingsWindow()}
      >
        Open prev recordings window
      </button>
      <Suspense fallback="LOADING">
        <Show when={options.data}>
          {(options) => (
            <>
              <div class="max-w-64 space-y-4">
                <div class="flex flex-col gap-1">
                  <label>Camera</label>
                  <div>
                    <select
                      class="w-full"
                      value={camera()?.deviceId}
                      onChange={(e) => {
                        const o = options();
                        const deviceId = e.target.value;
                        const label = cameras().find(
                          (c) => c.deviceId === deviceId
                        )?.label;
                        if (!label) return;

                        commands.setRecordingOptions({
                          ...o,
                          cameraLabel: label,
                        });
                      }}
                    >
                      <For each={cameras()}>
                        {(camera) => (
                          <option value={camera.deviceId}>
                            {camera.label}
                          </option>
                        )}
                      </For>
                    </select>
                    {options().cameraLabel && (
                      <button
                        type="button"
                        onClick={() =>
                          commands.setRecordingOptions({
                            ...options(),
                            cameraLabel: null,
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label>Capture</label>
                  <div class="flex flex-row justify-between gap-1">
                    <button
                      type="button"
                      class={cx(
                        "flex-1",
                        "screen" === options().captureTarget
                          ? "bg-neutral-200"
                          : "bg-neutral-100"
                      )}
                      onClick={() =>
                        commands.setRecordingOptions({
                          ...options(),
                          captureTarget: "screen",
                        })
                      }
                    >
                      Screen
                    </button>
                    <Show when={windows.data?.[0]}>
                      {(window) => (
                        <button
                          type="button"
                          class={cx(
                            "flex-1",
                            options().captureTarget !== "screen"
                              ? "bg-neutral-200"
                              : "bg-neutral-100"
                          )}
                          onClick={() => {
                            const captureTarget = options();
                            if (
                              typeof captureTarget === "object" &&
                              "window" in captureTarget
                            )
                              return;

                            commands.setRecordingOptions({
                              ...options(),
                              captureTarget: { window: window().id },
                            });
                          }}
                        >
                          Window
                        </button>
                      )}
                    </Show>
                  </div>
                  <Show
                    when={(() => {
                      const captureTarget = options().captureTarget;
                      if (captureTarget === "screen") return;

                      return {
                        windows: windows.data,
                        windowId: captureTarget.window,
                      };
                    })()}
                  >
                    {(data) => (
                      <select
                        class="w-full"
                        value={data().windowId}
                        onChange={(e) => {
                          const o = options();
                          commands.setRecordingOptions({
                            ...o,
                            captureTarget: { window: Number(e.target.value) },
                          });
                        }}
                      >
                        <For each={data().windows}>
                          {(window) => (
                            <option value={window.id}>{window.name}</option>
                          )}
                        </For>
                      </select>
                    )}
                  </Show>
                </div>
                {
                  <div>
                    {!isRecording() ? (
                      <button
                        type="button"
                        onClick={() =>
                          commands
                            .startRecording()
                            .then(() => setIsRecording(true))
                        }
                      >
                        Start Recording
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          commands
                            .stopRecording()
                            .then(() => setIsRecording(false))
                        }
                      >
                        Stop Recording
                      </button>
                    )}
                  </div>
                }
              </div>
            </>
          )}
        </Show>
      </Suspense>
    </>
  );
}
