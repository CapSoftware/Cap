import { Button } from "@cap/ui-solid";
import { cx } from "cva";
import {
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { type as ostype } from "@tauri-apps/plugin-os";
import { Tooltip } from "@kobalte/core";
import { Select as KSelect } from "@kobalte/core/select";
import { createMutation } from "@tanstack/solid-query";
import { getRequestEvent } from "solid-js/web";
import { save } from "@tauri-apps/plugin-dialog";
import { Channel } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";

import { type RenderProgress, commands } from "~/utils/tauri";
import {
  canCreateShareableLink,
  checkIsUpgradedAndUpdate,
} from "~/utils/plans";
import { FPS, useEditorContext } from "./context";
import {
  Dialog,
  DialogContent,
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
} from "./ui";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import {
  type ProgressState,
  progressState,
  setProgressState,
} from "~/store/progress";
import { events } from "~/utils/tauri";
import Titlebar from "~/components/titlebar/Titlebar";
import { initializeTitlebar, setTitlebar } from "~/utils/titlebar-state";

type ResolutionOption = {
  label: string;
  value: string;
  width: number;
  height: number;
};

const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { label: "720p", value: "720p", width: 1280, height: 720 },
  { label: "1080p", value: "1080p", width: 1920, height: 1080 },
  { label: "4K", value: "4k", width: 3840, height: 2160 },
];

const FPS_OPTIONS = [
  { label: "30 FPS", value: 30 },
  { label: "60 FPS", value: 60 },
] satisfies Array<{ label: string; value: number }>;

export function Header() {
  const currentWindow = getCurrentWindow();
  const { videoId, project, prettyName } = useEditorContext();

  const [showExportOptions, setShowExportOptions] = createSignal(false);
  const [selectedFps, setSelectedFps] = createSignal(
    Number(localStorage.getItem("cap-export-fps")) || 30
  );
  const [selectedResolution, setSelectedResolution] =
    createSignal<ResolutionOption>(
      RESOLUTION_OPTIONS.find(
        (opt) => opt.value === localStorage.getItem("cap-export-resolution")
      ) || RESOLUTION_OPTIONS[0]
    );

  let unlistenTitlebar: UnlistenFn | undefined;
  onMount(async () => {
    unlistenTitlebar = await initializeTitlebar();
  });
  onCleanup(() => unlistenTitlebar?.());

  // Save settings when they change
  createEffect(() => {
    localStorage.setItem("cap-export-fps", selectedFps().toString());
    localStorage.setItem("cap-export-resolution", selectedResolution().value);
  });

  createEffect(() => {
    const state = progressState;
    if (state === undefined || state.type === "idle") {
      currentWindow.setProgressBar({ status: ProgressBarStatus.None });
      return;
    }

    let percentage: number | undefined;
    if (state.type === "saving") {
      percentage =
        state.stage === "rendering"
          ? Math.min(
              ((state.renderProgress || 0) / (state.totalFrames || 1)) * 100,
              100
            )
          : Math.min(state.progress || 0, 100);
    }

    if (percentage)
      currentWindow.setProgressBar({ progress: Math.round(percentage) });
  });

  const exportWithSettings = async () => {
    setShowExportOptions(false);

    const path = await save({
      filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
      defaultPath: `~/Desktop/${prettyName()}.mp4`,
    });
    if (!path) return;

    setProgressState({
      type: "saving",
      progress: 0,
      renderProgress: 0,
      totalFrames: 0,
      message: "Preparing to render...",
      mediaPath: path,
      stage: "rendering",
    });

    const progress = new Channel<RenderProgress>();
    progress.onmessage = (p) => {
      if (p.type === "FrameRendered" && progressState.type === "saving") {
        const percentComplete = Math.min(
          Math.round(
            (p.current_frame / (progressState.totalFrames || 1)) * 100
          ),
          100
        );

        setProgressState({
          ...progressState,
          renderProgress: p.current_frame,
          message: `Rendering video - ${percentComplete}%`,
        });

        // If rendering is complete, update to finalizing state
        if (percentComplete === 100) {
          setProgressState({
            ...progressState,
            message: "Finalizing export...",
          });
        }
      }
      if (
        p.type === "EstimatedTotalFrames" &&
        progressState.type === "saving"
      ) {
        setProgressState({
          ...progressState,
          totalFrames: p.total_frames,
          message: "Starting render...",
        });
      }
    };

    try {
      const videoPath = await commands.exportVideo(
        videoId,
        project,
        progress,
        true,
        selectedFps(),
        {
          x: selectedResolution().width,
          y: selectedResolution().height,
        }
      );
      await commands.copyFileToPath(videoPath, path);

      setProgressState({
        type: "saving",
        progress: 100,
        message: "Saved successfully!",
        mediaPath: path,
      });

      setTimeout(() => {
        setProgressState({ type: "idle" });
      }, 1500);
    } catch (error) {
      setProgressState({ type: "idle" });
      throw error;
    }
  };

  batch(() => {
    setTitlebar("border", false);
    setTitlebar("height", "4rem");
    setTitlebar("transparent", true);
    setTitlebar(
      "items",
      <div
        data-tauri-drag-region
        class={cx(
          "flex flex-row justify-between items-center w-full cursor-default pr-5",
          ostype() === "windows" ? "pl-[4.3rem]" : "pl-[1.25rem]"
        )}
      >
        <div class="flex flex-row items-center gap-[0.5rem] text-[0.875rem]"></div>
        <div class="flex flex-row gap-2 font-medium items-center">
          <ShareButton
            selectedResolution={selectedResolution}
            selectedFps={selectedFps}
          />
          <div class="relative">
            <Button
              variant="primary"
              onClick={() => setShowExportOptions(!showExportOptions())}
            >
              Export
            </Button>
            <Show when={showExportOptions()}>
              <div class="absolute right-0 top-full mt-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-40 p-4 min-w-[240px]">
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                      Resolution
                    </label>
                    <KSelect<ResolutionOption>
                      options={RESOLUTION_OPTIONS}
                      optionValue="value"
                      optionTextValue="label"
                      placeholder="Select Resolution"
                      value={selectedResolution()}
                      onChange={setSelectedResolution}
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
                        <KSelect.Value<ResolutionOption> class="flex-1 text-sm text-left truncate">
                          {(state) => (
                            <span>{state.selectedOption()?.label}</span>
                          )}
                        </KSelect.Value>
                        <KSelect.Icon>
                          <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
                        </KSelect.Icon>
                      </KSelect.Trigger>
                      <KSelect.Portal>
                        <PopperContent<typeof KSelect.Content>
                          as={KSelect.Content}
                          class={cx(topLeftAnimateClasses, "z-50")}
                        >
                          <MenuItemList<typeof KSelect.Listbox>
                            class="max-h-32 overflow-y-auto"
                            as={KSelect.Listbox}
                          />
                        </PopperContent>
                      </KSelect.Portal>
                    </KSelect>
                  </div>
                  <div>
                    <label class="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                      Frame Rate
                    </label>
                    <KSelect<(typeof FPS_OPTIONS)[number]>
                      options={FPS_OPTIONS}
                      optionValue="value"
                      optionTextValue="label"
                      placeholder="Select FPS"
                      value={FPS_OPTIONS.find(
                        (opt) => opt.value === selectedFps()
                      )}
                      onChange={(option) => setSelectedFps(option?.value ?? 30)}
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
                        > class="flex-1 text-sm text-left truncate">
                          {(state) => (
                            <span>{state.selectedOption()?.label}</span>
                          )}
                        </KSelect.Value>
                        <KSelect.Icon>
                          <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
                        </KSelect.Icon>
                      </KSelect.Trigger>
                      <KSelect.Portal>
                        <PopperContent<typeof KSelect.Content>
                          as={KSelect.Content}
                          class={cx(topLeftAnimateClasses, "z-50")}
                        >
                          <MenuItemList<typeof KSelect.Listbox>
                            class="max-h-32 overflow-y-auto"
                            as={KSelect.Listbox}
                          />
                        </PopperContent>
                      </KSelect.Portal>
                    </KSelect>
                  </div>
                  <Button
                    variant="primary"
                    class="w-full justify-center"
                    onClick={exportWithSettings}
                  >
                    Export Video
                  </Button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    );
  });

  return (
    <>
      <Titlebar />
      <Dialog.Root open={progressState.type !== "idle"} onOpenChange={() => {}}>
        <DialogContent
          title={
            progressState.type === "copying"
              ? "Link Copied"
              : progressState.type === "uploading"
              ? "Creating Shareable Link"
              : "Exporting Recording"
          }
          confirm={<></>}
          class="bg-gray-600 text-gray-500 dark:text-gray-500"
        >
          <div class="min-h-[120px] flex items-center justify-center relative">
            <Switch>
              <Match when={progressState.type === "copying"}>
                {(when) => {
                  const state = progressState as Extract<
                    ProgressState,
                    { type: "copying" }
                  >;
                  return (
                    <div class="w-[80%] text-center mx-auto relative z-10">
                      <h3 class="text-sm font-medium mb-3 text-gray-50">
                        {state.stage === "rendering"
                          ? "Rendering video"
                          : "Copying to clipboard"}
                      </h3>

                      <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                        <div
                          class="bg-blue-300 h-2.5 rounded-full transition-all duration-200"
                          style={{
                            width: `${
                              state.stage === "rendering"
                                ? Math.min(
                                    ((state.renderProgress || 0) /
                                      (state.totalFrames || 1)) *
                                      100,
                                    100
                                  )
                                : Math.min(state.progress || 0, 100)
                            }%`,
                          }}
                        />
                      </div>

                      <p class="text-xs mt-3 relative z-10">
                        {state.stage === "rendering" &&
                        state.renderProgress &&
                        state.totalFrames
                          ? `${state.message} (${state.renderProgress}/${state.totalFrames} frames)`
                          : state.message}
                      </p>
                    </div>
                  );
                }}
              </Match>
              <Match when={progressState.type === "saving"}>
                {(when) => {
                  const state = progressState as Extract<
                    ProgressState,
                    { type: "saving" }
                  >;
                  return (
                    <div class="w-[80%] text-center mx-auto relative z-10">
                      <h3 class="text-sm font-medium mb-3 text-gray-50">
                        {state.stage === "rendering"
                          ? "Rendering video"
                          : "Saving file"}
                      </h3>

                      <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                        <div
                          class="bg-blue-300 h-2.5 rounded-full transition-all duration-200"
                          style={{
                            width: `${
                              state.stage === "rendering"
                                ? Math.min(
                                    ((state.renderProgress || 0) /
                                      (state.totalFrames || 1)) *
                                      100,
                                    100
                                  )
                                : Math.min(state.progress || 0, 100)
                            }%`,
                          }}
                        />
                      </div>

                      <p class="text-xs mt-3 relative z-10">
                        {state.stage === "rendering" &&
                        state.renderProgress &&
                        state.totalFrames
                          ? `${state.message} (${state.renderProgress}/${state.totalFrames} frames)`
                          : state.message}
                      </p>
                    </div>
                  );
                }}
              </Match>
              <Match when={progressState.type === "uploading"}>
                {(when) => {
                  const state = progressState as Extract<
                    ProgressState,
                    { type: "uploading" }
                  >;
                  return (
                    <div class="w-[80%] text-center mx-auto relative z-10">
                      <h3 class="text-sm font-medium mb-3 text-gray-50">
                        {state.stage === "rendering"
                          ? "Rendering video"
                          : "Creating shareable link"}
                      </h3>

                      <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                        <div
                          class="bg-blue-300 h-2.5 rounded-full transition-all duration-200"
                          style={{
                            width: `${
                              state.stage === "rendering"
                                ? Math.min(state.renderProgress || 0, 100)
                                : Math.min(
                                    (state.uploadProgress || 0) * 100,
                                    100
                                  )
                            }%`,
                          }}
                        />
                      </div>

                      <p class="text-xs text-white mt-3 relative z-10">
                        {state.stage === "rendering"
                          ? `Rendering - ${Math.round(
                              state.renderProgress || 0
                            )}%`
                          : state.message}
                      </p>
                    </div>
                  );
                }}
              </Match>
            </Switch>
          </div>
        </DialogContent>
      </Dialog.Root>
    </>
  );
}

type ShareButtonProps = {
  selectedResolution: () => ResolutionOption;
  selectedFps: () => number;
};

function ShareButton(props: ShareButtonProps) {
  const { videoId, project, presets } = useEditorContext();
  const [recordingMeta, metaActions] = createResource(() =>
    commands.getRecordingMeta(videoId, "recording")
  );

  const uploadVideo = createMutation(() => ({
    mutationFn: async (useCustomMuxer: boolean) => {
      console.log("Starting upload process...");
      const meta = recordingMeta();
      if (!meta) {
        console.error("No recording metadata available");
        throw new Error("Recording metadata not available");
      }

      const metadata = await commands.getVideoMetadata(videoId, null);
      const canShare = await canCreateShareableLink(metadata?.duration);

      if (!canShare.allowed) {
        if (canShare.reason === "upgrade_required") {
          await commands.showWindow("Upgrade");
          throw new Error(
            "Upgrade required to share recordings over 5 minutes"
          );
        }
      }

      let unlisten: (() => void) | undefined;

      try {
        // Set initial progress state
        setProgressState({
          type: "uploading",
          renderProgress: 0,
          uploadProgress: 0,
          message: "Rendering - 0%",
          mediaPath: videoId,
          stage: "rendering",
        });

        // Setup progress listener before starting upload
        unlisten = await events.uploadProgress.listen((event) => {
          console.log("Upload progress event:", event.payload);
          if (progressState.type === "uploading") {
            const progress = Math.round(event.payload.progress * 100);
            if (event.payload.stage === "rendering") {
              setProgressState({
                type: "uploading",
                renderProgress: progress,
                uploadProgress: 0,
                message: `Rendering - ${progress}%`,
                mediaPath: videoId,
                stage: "rendering",
              });
            } else {
              setProgressState({
                type: "uploading",
                renderProgress: 100,
                uploadProgress: progress / 100,
                message: `Uploading - ${progress}%`,
                mediaPath: videoId,
                stage: "uploading",
              });
            }
          }
        });

        console.log("Starting actual upload...");

        setProgressState({
          type: "uploading",
          renderProgress: 0,
          uploadProgress: 0,
          message: "Rendering - 0%",
          mediaPath: videoId,
          stage: "rendering",
        });

        const progress = new Channel<RenderProgress>();
        progress.onmessage = (p) => {
          console.log("Progress channel message:", p);
          if (
            p.type === "FrameRendered" &&
            progressState.type === "uploading"
          ) {
            const renderProgress = Math.round(
              (p.current_frame / (progressState.totalFrames || 1)) * 100
            );
            setProgressState({
              ...progressState,
              message: `Rendering - ${renderProgress}%`,
              renderProgress,
            });
          }
          if (
            p.type === "EstimatedTotalFrames" &&
            progressState.type === "uploading"
          ) {
            console.log("Got total frames:", p.total_frames);
            setProgressState({
              ...progressState,
              totalFrames: p.total_frames,
            });
          }
        };

        getRequestEvent()?.nativeEvent;

        await commands.exportVideo(
          videoId,
          project,
          progress,
          true,
          props.selectedFps(),
          {
            x: props.selectedResolution().width,
            y: props.selectedResolution().height,
          }
        );

        // Now proceed with upload
        const result = recordingMeta()?.sharing
          ? await commands.uploadExportedVideo(videoId, "Reupload")
          : await commands.uploadExportedVideo(videoId, {
              Initial: { pre_created_video: null },
            });

        if (result === "NotAuthenticated") {
          throw new Error("You need to sign in to share recordings");
        }
        if (result === "PlanCheckFailed") {
          throw new Error("Failed to verify your subscription status");
        }
        if (result === "UpgradeRequired") {
          throw new Error("This feature requires an upgraded plan");
        }

        // Show success state briefly before resetting
        setProgressState({
          type: "uploading",
          renderProgress: 100,
          uploadProgress: 100,
          message: "Upload complete!",
          mediaPath: videoId,
          stage: "uploading",
        });

        setTimeout(() => {
          setProgressState({ type: "idle" });
        }, 1500);

        return result;
      } catch (error) {
        console.error("Upload error:", error);
        setProgressState({ type: "idle" });
        throw error instanceof Error
          ? error
          : new Error("Failed to upload recording");
      } finally {
        if (unlisten) {
          console.log("Cleaning up upload progress listener");
          unlisten();
        }
      }
    },
    onSuccess: () => {
      console.log("Upload successful, refreshing metadata");
      metaActions.refetch();
    },
    onError: (error) => {
      console.error("Upload mutation error:", error);
      setProgressState({ type: "idle" });
      commands.globalMessageDialog(
        error instanceof Error ? error.message : "Failed to upload recording"
      );
    },
  }));

  return (
    <Show
      when={recordingMeta()?.sharing}
      fallback={
        <Button
          disabled={uploadVideo.isPending}
          onClick={(e) =>
            uploadVideo.mutate((e.ctrlKey || e.metaKey) && e.shiftKey)
          }
          variant="primary"
          class="flex items-center space-x-1"
        >
          {uploadVideo.isPending ? (
            <>
              <span>Uploading Cap</span>
              <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
            </>
          ) : (
            "Create Shareable Link"
          )}
        </Button>
      }
    >
      {(sharing) => {
        const url = () => new URL(sharing().link);

        return (
          <div class="flex flex-row items-center gap-2">
            <Tooltip.Root openDelay={0} closeDelay={0}>
              <Tooltip.Trigger>
                <Button
                  disabled={uploadVideo.isPending}
                  onClick={(e) =>
                    uploadVideo.mutate((e.ctrlKey || e.metaKey) && e.shiftKey)
                  }
                  variant="secondary"
                  class="flex items-center space-x-1"
                >
                  {uploadVideo.isPending ? (
                    <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
                  ) : (
                    <IconLucideRotateCcw class="size-[1rem]" />
                  )}
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
                  {uploadVideo.isPending
                    ? "Reuploading video"
                    : "Reupload video"}
                  <Tooltip.Arrow class="fill-gray-500" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
            <a
              class="rounded-full h-[2rem] px-[1rem] flex flex-row items-center gap-[0.375rem] bg-gray-200 hover:bg-gray-300 transition-colors duration-100"
              href={sharing().link}
              target="_blank"
              rel="noreferrer"
            >
              <span class="text-[0.875rem] text-gray-500">
                {url().host}
                {url().pathname}
              </span>
            </a>
          </div>
        );
      }}
    </Show>
  );
}
