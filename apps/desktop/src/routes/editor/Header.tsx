import { Button } from "@cap/ui-solid";
import { cx } from "cva";
import {
  Setter,
  Show,
  batch,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  ErrorBoundary,
  Suspense,
} from "solid-js";
import { type as ostype } from "@tauri-apps/plugin-os";
import { Tooltip } from "@kobalte/core";
import { Select as KSelect } from "@kobalte/core/select";
import { createMutation } from "@tanstack/solid-query";
import { save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { createStore, produce } from "solid-js/store";

import { commands, events, RenderProgress } from "~/utils/tauri";
import { useEditorContext } from "./context";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import {
  Dialog,
  DialogContent,
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
} from "./ui";
import Titlebar from "~/components/titlebar/Titlebar";
import { initializeTitlebar, setTitlebar } from "~/utils/titlebar-state";
import { Channel } from "@tauri-apps/api/core";
import { createLicenseQuery } from "~/utils/queries";

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

export interface ExportEstimates {
  duration_seconds: number;
  estimated_time_seconds: number;
  estimated_size_mb: number;
}

export function Header() {
  const currentWindow = getCurrentWindow();
  const license = createLicenseQuery();

  const [selectedFps, setSelectedFps] = createSignal(
    Number(localStorage.getItem("cap-export-fps")) || 30
  );
  const [selectedResolution, setSelectedResolution] =
    createSignal<ResolutionOption>(
      RESOLUTION_OPTIONS.find(
        (opt) => opt.value === localStorage.getItem("cap-export-resolution")
      ) || RESOLUTION_OPTIONS[0]
    );

  // Save settings when they change
  createEffect(() => {
    localStorage.setItem("cap-export-fps", selectedFps().toString());
    localStorage.setItem("cap-export-resolution", selectedResolution().value);
  });

  let unlistenTitlebar: UnlistenFn | undefined;
  onMount(async () => {
    unlistenTitlebar = await initializeTitlebar();
  });
  onCleanup(() => unlistenTitlebar?.());

  batch(() => {
    setTitlebar("border", false);
    setTitlebar("height", "4rem");
    setTitlebar("transparent", false);
    setTitlebar(
      "items",
      <div
        data-tauri-drag-region
        class={cx(
          "flex flex-row justify-end items-center w-full cursor-default pr-5",
          ostype() === "windows" ? "pl-[4.3rem]" : "pl-[1.25rem]"
        )}
      >
        <div class="flex flex-row gap-2 font-medium items-center">
          <ShareButton
            selectedResolution={selectedResolution}
            selectedFps={selectedFps}
          />
          <ExportButton
            selectedResolution={selectedResolution()}
            selectedFps={selectedFps()}
            setSelectedFps={setSelectedFps}
            setSelectedResolution={setSelectedResolution}
          />
        </div>
      </div>
    );
  });

  return (
    <div class="relative">
      <div class="absolute left-[6rem] top-[1.25rem] z-10">
        <ErrorBoundary fallback={<></>}>
          <Suspense>
            <span
              onClick={async () => {
                if (license.data?.type !== "pro") {
                  await commands.showWindow("Upgrade");
                }
              }}
              class={`text-[0.85rem] ${
                license.data?.type === "pro"
                  ? "bg-[--blue-400] text-gray-50 dark:text-gray-500"
                  : "bg-gray-200 cursor-pointer hover:bg-gray-300"
              } rounded-lg px-1.5 py-0.5`}
            >
              {license.data?.type === "commercial"
                ? "Commercial License"
                : license.data?.type === "pro"
                ? "Pro"
                : "Personal License"}
            </span>
          </Suspense>
        </ErrorBoundary>
      </div>
      <Titlebar />
    </div>
  );
}

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
          project,
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
        variant="primary"
        onClick={() => {
          trackEvent("export_button_clicked");
          setShowExportOptions(!showExportOptions());
        }}
      >
        Export
      </Button>
      <Show when={showExportOptions()}>
        <div class="absolute right-0 top-full mt-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-40 p-4 min-w-[240px]">
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-1 text-gray-500 dark:text-gray-400">
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
                      class="max-h-32 overflow-y-auto"
                      as={KSelect.Listbox}
                    />
                  </PopperContent>
                </KSelect.Portal>
              </KSelect>
            </div>
            <div>
              <label class="block text-sm font-medium mb-1 text-gray-500 dark:text-gray-400">
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
              onClick={() => exportWithSettings.mutate()}
            >
              Export Video
            </Button>
            <Show when={exportEstimates.latest}>
              {(est) => (
                <div
                  class={cx(
                    "font-medium z-40 flex justify-between items-center pointer-events-none transition-all max-w-full overflow-hidden text-xs"
                  )}
                >
                  <p class="flex items-center gap-4">
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
          class="bg-gray-600 text-gray-500 dark:text-gray-500"
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
            <p class="text-xs mt-3 relative z-10">
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

function ShareButton(props: {
  selectedResolution: () => ResolutionOption;
  selectedFps: () => number;
}) {
  const { videoId, project } = useEditorContext();
  const [recordingMeta, metaActions] = createResource(() =>
    commands.getRecordingMeta(videoId, "recording")
  );

  const uploadVideo = createMutation(() => ({
    mutationFn: async () => {
      setUploadState({ type: "idle" });

      console.log("Starting upload process...");

      // Check authentication first
      const existingAuth = await authStore.get();
      if (!existingAuth) {
        await commands.showWindow("SignIn");
        throw new Error("You need to sign in to share recordings");
      }

      trackEvent("create_shareable_link_clicked", {
        resolution: props.selectedResolution().value,
        fps: props.selectedFps(),
        has_existing_auth: !!existingAuth,
      });

      const meta = recordingMeta();
      if (!meta) {
        console.error("No recording metadata available");
        throw new Error("Recording metadata not available");
      }

      const metadata = await commands.getVideoMetadata(videoId, null);
      const plan = await commands.checkUpgradedAndUpdate();
      const canShare = {
        allowed: plan || metadata.duration < 300,
        reason: !plan && metadata.duration >= 300 ? "upgrade_required" : null,
      };

      if (!canShare.allowed) {
        if (canShare.reason === "upgrade_required") {
          await commands.showWindow("Upgrade");
          throw new Error(
            "Upgrade required to share recordings longer than 5 minutes"
          );
        }
      }

      const unlisten = await events.uploadProgress.listen((event) => {
        console.log("Upload progress event:", event.payload);
        setUploadState(
          produce((state) => {
            if (state.type !== "uploading") return;

            state.progress = Math.round(event.payload.progress * 100);
          })
        );
      });

      try {
        setUploadState({ type: "starting" });

        // Setup progress listener before starting upload

        console.log("Starting actual upload...");

        const progress = new Channel<RenderProgress>();

        progress.onmessage = (msg) => {
          if (msg.type === "EstimatedTotalFrames")
            setUploadState({
              type: "rendering",
              renderedFrames: 0,
              totalFrames: msg.total_frames,
            });
          else
            setUploadState(
              produce((state) => {
                if (msg.type === "FrameRendered" && state.type === "rendering")
                  state.renderedFrames = msg.current_frame;
              })
            );
        };

        await commands.exportVideo(
          videoId,
          project,
          progress,
          true,
          props.selectedFps(),
          {
            x: props.selectedResolution()?.width || RESOLUTION_OPTIONS[0].width,
            y:
              props.selectedResolution()?.height ||
              RESOLUTION_OPTIONS[0].height,
          }
        );

        setUploadState({ type: "uploading", progress: 0 });

        // Now proceed with upload
        const result = recordingMeta()?.sharing
          ? await commands.uploadExportedVideo(videoId, "Reupload")
          : await commands.uploadExportedVideo(videoId, {
              Initial: { pre_created_video: null },
            });

        if (result === "NotAuthenticated") {
          await commands.showWindow("SignIn");
          throw new Error("You need to sign in to share recordings");
        } else if (result === "PlanCheckFailed")
          throw new Error("Failed to verify your subscription status");
        else if (result === "UpgradeRequired")
          throw new Error("This feature requires an upgraded plan");

        setUploadState({ type: "link-copied" });

        return result;
      } catch (error) {
        console.error("Upload error:", error);
        throw error instanceof Error
          ? error
          : new Error("Failed to upload recording");
      } finally {
        unlisten();
      }
    },
    onSuccess: () => {
      metaActions.refetch();
    },
    onError: (error) => {
      commands.globalMessageDialog(
        error instanceof Error ? error.message : "Failed to upload recording"
      );
    },
    onSettled() {
      setTimeout(() => {
        setUploadState({ type: "idle" });
        uploadVideo.reset();
      }, 2000);
    },
  }));

  const [uploadState, setUploadState] = createStore<
    | { type: "idle" }
    | { type: "starting" }
    | { type: "rendering"; renderedFrames: number; totalFrames: number }
    | { type: "uploading"; progress: number }
    | { type: "link-copied" }
  >({ type: "idle" });

  createProgressBar(() => {
    if (uploadVideo.isIdle || uploadState.type === "idle") return;
    if (uploadState.type === "starting") return 0;
    if (uploadState.type === "rendering")
      return (uploadState.renderedFrames / uploadState.totalFrames) * 100;
    if (uploadState.type === "uploading") return uploadState.progress;
    return 100;
  });

  return (
    <div class="relative">
      <Show
        when={recordingMeta.latest?.sharing}
        fallback={
          <Button
            disabled={uploadVideo.isPending}
            onClick={(e) => uploadVideo.mutate()}
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
                    onClick={(e) => uploadVideo.mutate()}
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
      <Dialog.Root open={!uploadVideo.isIdle}>
        <DialogContent
          title={
            uploadState.type === "uploading"
              ? "Creating Shareable Link"
              : uploadState.type === "link-copied"
              ? "Link Copied"
              : "Exporting Recording"
          }
          confirm={<></>}
          close={<></>}
          class="bg-gray-600 text-gray-500 dark:text-gray-500"
        >
          <div class="w-[80%] text-center mx-auto relative z-10 space-y-6 py-4">
            <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
              <div
                class="bg-blue-300 h-2.5 rounded-full"
                style={{
                  width: `${
                    uploadState.type === "uploading"
                      ? uploadState.progress
                      : uploadState.type === "link-copied"
                      ? 100
                      : uploadState.type === "rendering"
                      ? Math.min(
                          (uploadState.renderedFrames /
                            uploadState.totalFrames) *
                            100,
                          100
                        )
                      : 0
                  }%`,
                }}
              />
            </div>

            <p class="text-xs text-white mt-3 relative z-10">
              {uploadState.type == "idle" || uploadState.type === "starting"
                ? "Preparing to render..."
                : uploadState.type === "rendering"
                ? `Rendering video (${uploadState.renderedFrames}/${uploadState.totalFrames} frames)`
                : uploadState.type === "uploading"
                ? `Uploading - ${Math.floor(uploadState.progress)}%`
                : "Link copied to clipboard!"}
            </p>
          </div>
        </DialogContent>
      </Dialog.Root>
    </div>
  );
}

function createProgressBar(progress: () => number | undefined) {
  const currentWindow = getCurrentWindow();

  createEffect(() => {
    const p = progress();
    console.log({ p });
    if (p === undefined)
      currentWindow.setProgressBar({ status: ProgressBarStatus.None });
    else currentWindow.setProgressBar({ progress: Math.round(p) });
  });
}
