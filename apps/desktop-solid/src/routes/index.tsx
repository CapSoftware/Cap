import { cx } from "cva";
import { For, Show, Suspense, createSignal } from "solid-js";

import { createCameraForLabel, createCameras } from "../utils/media";
import { createOptionsQuery, createWindowsQuery } from "../utils/queries";
import { commands, events } from "../utils/tauri";
import Header from "../components/Header";

import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import {
  EditorButton,
  MenuItemList,
  PopperContent,
  DropdownItem,
  topLeftAnimateClasses,
} from "./editor/ui";

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

  commands.showPreviousRecordingsWindow();

  return (
    <>
      <Header />
      <div class="px-3">
        <Suspense fallback="LOADING">
          <Show when={options.data}>
            {(options) => (
              <>
                <div class="max-w-64 space-y-4">
                  <div class="flex flex-col gap-1">
                    <label>Capture</label>
                    <div class="flex flex-row justify-between gap-1 border border-gray-200 rounded-[8px]">
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
                          <KDropdownMenu gutter={8}>
                            <EditorButton<typeof KDropdownMenu.Trigger>
                              as={KDropdownMenu.Trigger}
                              class={cx(
                                "flex-1",
                                options().captureTarget !== "screen"
                                  ? "bg-neutral-200"
                                  : "bg-neutral-100"
                              )}
                            >
                              Window
                            </EditorButton>
                            <KDropdownMenu.Portal>
                              <PopperContent<typeof KDropdownMenu.Content>
                                as={KDropdownMenu.Content}
                                class={cx(
                                  "w-72 max-h-56",
                                  topLeftAnimateClasses
                                )}
                              >
                                <MenuItemList<typeof KDropdownMenu.Group>
                                  as={KDropdownMenu.Group}
                                  class="flex-1 overflow-y-auto scrollbar-none"
                                >
                                  <For each={windows.data}>
                                    {(window) => (
                                      <DropdownItem
                                        onSelect={() => {
                                          commands.setRecordingOptions({
                                            ...options(),
                                            captureTarget: {
                                              window: window.id,
                                            },
                                          });
                                        }}
                                      >
                                        {window.name}
                                      </DropdownItem>
                                    )}
                                  </For>
                                </MenuItemList>
                              </PopperContent>
                            </KDropdownMenu.Portal>
                          </KDropdownMenu>
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
                  <div class="flex flex-col gap-1">
                    <label>Camera</label>
                    <div class="relative">
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
                  <div class="flex flex-col gap-1">
                    <label>Microphone</label>
                    <div class="flex items-center gap-2">
                      <select class="w-full">
                        <option>No Audio</option>
                      </select>
                      <button type="button">Off</button>
                    </div>
                  </div>
                  <div class="flex flex-col gap-1">
                    <button
                      type="button"
                      class="bg-blue-500 text-white py-2 rounded"
                      onClick={() =>
                        commands
                          .startRecording()
                          .then(() => setIsRecording(true))
                      }
                    >
                      Start Recording
                    </button>
                    <button type="button" class="text-blue-500">
                      Open Cap on Web
                    </button>
                  </div>
                </div>
              </>
            )}
          </Show>
        </Suspense>
      </div>
    </>
  );
}
