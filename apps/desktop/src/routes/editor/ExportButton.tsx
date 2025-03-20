import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { createMutation } from "@tanstack/solid-query";
import { save } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import { createResource, createSignal, Setter, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { Channel } from "@tauri-apps/api/core";
import { createProgressBar } from "~/routes/editor/utils";
import { trackEvent } from "~/utils/analytics";
import { commands, RenderProgress } from "~/utils/tauri";
import { useEditorContext } from "./context";
import { RESOLUTION_OPTIONS, ResolutionOption } from "./Header";
import {
  Dialog,
  DialogContent,
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
} from "./ui";

const FPS_OPTIONS = [
  { label: "30 FPS", value: 30 },
  { label: "60 FPS", value: 60 },
] satisfies Array<{ label: string; value: number }>;

function ExportButton(props: {
  selectedFps: number;
  selectedResolution: ResolutionOption;
  setSelectedResolution: Setter<ResolutionOption>;
  setSelectedFps: Setter<number>;
}) {
  const { videoId, project, prettyName } = useEditorContext();
  const [showExportOptions, setShowExportOptions] = createSignal(false);

  const [exportEstimates] = createResource(
    () => ({
      videoId,
      resolution: {
        x: props.selectedResolution.width,
        y: props.selectedResolution.height,
      },
      fps: props.selectedFps,
    }),
    (params) =>
      commands.getExportEstimates(params.videoId, params.resolution, params.fps)
  );

  const exportWithSettings = createMutation(() => ({
    mutationFn: async () => {
      setExportState({ type: "idle" });

      setShowExportOptions(false);

      const path = await save({
        filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
        defaultPath: `~/Desktop/${prettyName()}.mp4`,
      });
      if (!path) return;

      trackEvent("export_started", {
        resolution: props.selectedResolution.value,
        fps: props.selectedFps,
        path: path,
      });

      setExportState({ type: "starting" });

      const progress = new Channel<RenderProgress>();

      progress.onmessage = (msg) => {
        if (msg.type === "EstimatedTotalFrames")
          setExportState({
            type: "rendering",
            renderedFrames: 0,
            totalFrames: msg.total_frames,
          });
        else
          setExportState(
            produce((state) => {
              if (msg.type === "FrameRendered" && state.type === "rendering")
                state.renderedFrames = msg.current_frame;
            })
          );
      };

      try {
        const videoPath = await commands.exportVideo(
          videoId,
          progress,
          true,
          props.selectedFps,
          {
            x: props.selectedResolution.width,
            y: props.selectedResolution.height,
          }
        );

        setExportState({ type: "saving", done: false });

        await commands.copyFileToPath(videoPath, path);

        setExportState({ type: "saving", done: false });
      } catch (error) {
        throw error;
      }
    },
    onSettled() {
      setTimeout(() => {
        exportWithSettings.reset();
      }, 2000);
    },
  }));

  const [exportState, setExportState] = createStore<
    | { type: "idle" }
    | { type: "starting" }
    | { type: "rendering"; renderedFrames: number; totalFrames: number }
    | { type: "saving"; done: boolean }
  >({ type: "idle" });

  createProgressBar(() => {
    if (exportWithSettings.isIdle || exportState.type === "idle") return;
    if (exportState.type === "starting") return 0;
    if (exportState.type === "rendering")
      return (exportState.renderedFrames / exportState.totalFrames) * 100;
    return 100;
  });

  return (
    <div class="relative">
      <Button
        variant="white"
        class={cx("flex gap-2 justify-center")}
        onClick={() => {
          trackEvent("export_button_clicked");
          setShowExportOptions(!showExportOptions());
        }}
      >
        <IconCapUpload class="size-5" />
        Export
      </Button>
      <Show when={showExportOptions()}>
        <div class="absolute right-0 top-full mt-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-40 p-4 min-w-[240px]">
          <div class="space-y-4">
            <div>
              <label class="block mb-1 text-sm font-medium text-gray-500 dark:text-gray-400">
                Resolution
              </label>
              <KSelect<ResolutionOption>
                options={RESOLUTION_OPTIONS}
                optionValue="value"
                optionTextValue="label"
                placeholder="Select Resolution"
                value={props.selectedResolution}
                onChange={(value) => {
                  if (value) {
                    trackEvent("export_resolution_changed", {
                      resolution: value.value,
                      width: value.width,
                      height: value.height,
                    });
                    props.setSelectedResolution(value);
                  }
                }}
                itemComponent={(props) => (
                  <MenuItem<typeof KSelect.Item>
                    as={KSelect.Item}
                    item={props.item}
                  >
                    <KSelect.ItemLabel class="flex-1">
                      {props.item.rawValue.label}
                    </KSelect.ItemLabel>
                  </MenuItem>
                )}
              >
                <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect">
                  <KSelect.Value<ResolutionOption> class="flex-1 text-sm text-left truncate text-[--gray-500]">
                    {(state) => <span>{state.selectedOption()?.label}</span>}
                  </KSelect.Value>
                  <KSelect.Icon>
                    <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]" />
                  </KSelect.Icon>
                </KSelect.Trigger>
                <KSelect.Portal>
                  <PopperContent<typeof KSelect.Content>
                    as={KSelect.Content}
                    class={cx(topLeftAnimateClasses, "z-50")}
                  >
                    <MenuItemList<typeof KSelect.Listbox>
                      class="overflow-y-auto max-h-32"
                      as={KSelect.Listbox}
                    />
                  </PopperContent>
                </KSelect.Portal>
              </KSelect>
            </div>
            <div>
              <label class="block mb-1 text-sm font-medium text-gray-500 dark:text-gray-400">
                FPS
              </label>
              <KSelect
                options={FPS_OPTIONS}
                optionValue="value"
                optionTextValue="label"
                placeholder="Select FPS"
                value={FPS_OPTIONS.find(
                  (opt) => opt.value === props.selectedFps
                )}
                onChange={(option) => {
                  const fps = option?.value ?? 30;
                  trackEvent("export_fps_changed", {
                    fps: fps,
                  });
                  props.setSelectedFps(fps);
                }}
                itemComponent={(props) => (
                  <MenuItem<typeof KSelect.Item>
                    as={KSelect.Item}
                    item={props.item}
                  >
                    <KSelect.ItemLabel class="flex-1">
                      {props.item.rawValue.label}
                    </KSelect.ItemLabel>
                  </MenuItem>
                )}
              >
                <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect">
                  <KSelect.Value<
                    (typeof FPS_OPTIONS)[number]
                  > class="flex-1 text-sm text-left truncate text-[--gray-500]">
                    {(state) => <span>{state.selectedOption()?.label}</span>}
                  </KSelect.Value>
                  <KSelect.Icon>
                    <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]" />
                  </KSelect.Icon>
                </KSelect.Trigger>
                <KSelect.Portal>
                  <PopperContent<typeof KSelect.Content>
                    as={KSelect.Content}
                    class={cx(topLeftAnimateClasses, "z-50")}
                  >
                    <MenuItemList<typeof KSelect.Listbox>
                      class="overflow-y-auto max-h-32"
                      as={KSelect.Listbox}
                    />
                  </PopperContent>
                </KSelect.Portal>
              </KSelect>
            </div>
            <Button
              variant="primary"
              class="justify-center w-full"
              onClick={() => exportWithSettings.mutate()}
            >
              Export Video
            </Button>
            <Show when={exportEstimates.latest}>
              {(est) => (
                <div
                  class={cx(
                    "flex overflow-hidden z-40 justify-between items-center max-w-full text-xs font-medium transition-all pointer-events-none"
                  )}
                >
                  <p class="flex gap-4 items-center">
                    <span class="flex items-center text-[--gray-500]">
                      <IconCapCamera class="w-[14px] h-[14px] mr-1.5 text-[--gray-500]" />
                      {(() => {
                        const totalSeconds = Math.round(est().duration_seconds);
                        const hours = Math.floor(totalSeconds / 3600);
                        const minutes = Math.floor((totalSeconds % 3600) / 60);
                        const seconds = totalSeconds % 60;

                        if (hours > 0) {
                          return `${hours}:${minutes
                            .toString()
                            .padStart(2, "0")}:${seconds
                            .toString()
                            .padStart(2, "0")}`;
                        }
                        return `${minutes}:${seconds
                          .toString()
                          .padStart(2, "0")}`;
                      })()}
                    </span>
                    <span class="flex items-center text-[--gray-500]">
                      <IconLucideHardDrive class="w-[14px] h-[14px] mr-1.5 text-[--gray-500]" />
                      {est().estimated_size_mb.toFixed(2)} MB
                    </span>
                    <span class="flex items-center text-[--gray-500]">
                      <IconLucideClock class="w-[14px] h-[14px] mr-1.5 text-[--gray-500]" />
                      {(() => {
                        const totalSeconds = Math.round(
                          est().estimated_time_seconds
                        );
                        const hours = Math.floor(totalSeconds / 3600);
                        const minutes = Math.floor((totalSeconds % 3600) / 60);
                        const seconds = totalSeconds % 60;

                        if (hours > 0) {
                          return `~${hours}:${minutes
                            .toString()
                            .padStart(2, "0")}:${seconds
                            .toString()
                            .padStart(2, "0")}`;
                        }
                        return `~${minutes}:${seconds
                          .toString()
                          .padStart(2, "0")}`;
                      })()}
                    </span>
                  </p>
                </div>
              )}
            </Show>
          </div>
        </div>
      </Show>
      <Dialog.Root
        open={!exportWithSettings.isIdle && exportState.type !== "idle"}
        onOpenChange={(o) => {
          // cancellation doesn't work yet
          // if (!o) exportWithSettings.reset();
        }}
      >
        <DialogContent
          title="Exporting Recording"
          confirm={<></>}
          close={<></>}
          class="text-gray-500 bg-gray-600 dark:text-gray-500"
        >
          <div class="w-[80%] text-center mx-auto relative z-10 space-y-6 py-4">
            <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
              <div
                class="bg-blue-300 h-2.5 rounded-full"
                style={{
                  width: `${
                    exportState.type === "saving"
                      ? 100
                      : exportState.type === "rendering"
                      ? Math.min(
                          (exportState.renderedFrames /
                            exportState.totalFrames) *
                            100,
                          100
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
            <p class="relative z-10 mt-3 text-xs">
              {exportState.type == "idle" || exportState.type === "starting"
                ? "Preparing to render..."
                : exportState.type === "rendering"
                ? `Rendering video (${exportState.renderedFrames}/${exportState.totalFrames} frames)`
                : "Exported successfully!"}
            </p>
          </div>
        </DialogContent>
      </Dialog.Root>
    </div>
  );
}

export default ExportButton;
