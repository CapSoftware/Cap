import { createMutation, createQuery } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import {
  type Accessor,
  type ComponentProps,
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  startTransition,
  onMount,
} from "solid-js";
import Tooltip from "@corvu/tooltip";
import { Button } from "@cap/ui-solid";
import { createElementBounds } from "@solid-primitives/bounds";
import { TransitionGroup } from "solid-transition-group";
import { makePersisted } from "@solid-primitives/storage";
import { Channel } from "@tauri-apps/api/core";

import {
  commands,
  events,
  UploadResult,
  type RenderProgress,
} from "~/utils/tauri";
import { DEFAULT_PROJECT_CONFIG } from "./editor/projectConfig";
import { createPresets } from "~/utils/createPresets";
import { progressState, setProgressState } from "~/store/progress";
import { createStore, produce } from "solid-js/store";

type MediaEntry = {
  path: string;
  prettyName: string;
  isNew: boolean;
  type?: "recording" | "screenshot";
};

export default function () {
  const presets = createPresets();
  const [recordings, setRecordings] = makePersisted(
    createStore<MediaEntry[]>([]),
    { name: "recordings-store" }
  );
  const [screenshots, setScreenshots] = makePersisted(
    createStore<MediaEntry[]>([]),
    { name: "screenshots-store" }
  );

  onMount(async () => {
    console.log("Setting up event listeners");

    const unlisten = await events.uploadProgress.listen((event) => {
      console.log("Upload progress event:", event.payload);
      if (progressState.type === "uploading") {
        if (event.payload.stage === "rendering") {
          setProgressState({
            type: "uploading",
            renderProgress: Math.round(event.payload.progress * 100),
            uploadProgress: 0,
            message: event.payload.message,
            mediaPath: progressState.mediaPath,
            stage: "rendering",
          });
        } else {
          setProgressState({
            type: "uploading",
            renderProgress: 100,
            uploadProgress: Math.round(event.payload.progress * 100),
            message: event.payload.message,
            mediaPath: progressState.mediaPath,
            stage: "uploading",
          });

          if (event.payload.progress === 1) {
            setTimeout(() => {
              setProgressState({ type: "idle" });
            }, 1500);
          }
        }
      }
    });

    onCleanup(() => {
      console.log("Cleaning up event listeners");
      unlisten();
    });
  });

  const addMediaEntry = (path: string, type?: "recording" | "screenshot") => {
    const setMedia = type === "screenshot" ? setScreenshots : setRecordings;
    setMedia(
      produce((state) => {
        if (state.some((entry) => entry.path === path)) return;
        const fileName = path.split("/").pop() || "";
        const match = fileName.match(
          /Cap (\d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2})/
        );
        const prettyName = match ? match[1].replace(/\./g, ":") : fileName;
        state.unshift({ path, prettyName, isNew: true, type });
      })
    );

    setTimeout(() => {
      setMedia(
        produce((state) => {
          const index = state.findIndex((entry) => entry.path === path);
          if (index !== -1) {
            state[index].isNew = false;
          }
        })
      );
    }, 3000);
  };

  events.newRecordingAdded.listen((event) => {
    addMediaEntry(event.payload.path, "recording");
  });

  events.newScreenshotAdded.listen((event) => {
    addMediaEntry(event.payload.path, "screenshot");
  });

  const allMedia = createMemo(() => [...recordings, ...screenshots]);

  return (
    <div
      class="w-screen h-[100vh] bg-transparent relative overflow-y-hidden"
      style={{
        "scrollbar-color": "auto transparent",
      }}
    >
      <div class="w-full relative left-0 bottom-0 flex flex-col-reverse pl-[40px] pb-[80px] gap-4 h-full overflow-y-auto">
        <div class="pt-12 w-full flex flex-col gap-4">
          <TransitionGroup
            enterToClass="translate-y-0"
            enterClass="opacity-0 translate-y-4"
            exitToClass="opacity-0 -translate-x-1/2 ease-out"
            exitClass="opacity-100 translate-x-0"
            exitActiveClass="absolute"
          >
            <For each={allMedia()}>
              {(media, i) => {
                const [ref, setRef] = createSignal<HTMLElement | null>(null);
                const normalizedPath = media.path.replace(/\\/g, "/");
                const mediaId = normalizedPath.split("/").pop()?.split(".")[0]!;

                const type = media.type ?? "recording";
                const fileId =
                  type === "recording"
                    ? mediaId
                    : normalizedPath
                        .split("screenshots/")[1]
                        .split("/")[0]
                        .replace(".cap", "");
                const isRecording = type !== "screenshot";

                const recordingMeta = createQuery(() => ({
                  queryKey: ["recordingMeta", fileId],
                  queryFn: () =>
                    commands.getRecordingMeta(
                      fileId,
                      isRecording ? "recording" : "screenshot"
                    ),
                  enabled: true,
                }));

                const copyMedia = createMutation(() => ({
                  mutationFn: async () => {
                    setProgressState({
                      type: "copying",
                      progress: 0,
                      renderProgress: 0,
                      totalFrames: 0,
                      message: "Preparing...",
                      mediaPath: media.path,
                      stage: "rendering",
                    });

                    try {
                      if (isRecording) {
                        let outputPath: string;

                        try {
                          // First try to get existing rendered video
                          outputPath = await commands.getRenderedVideo(
                            mediaId,
                            presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
                          );
                          console.log("Using existing rendered video");

                          // Show quick progress animation for existing video
                          setProgressState({
                            type: "copying",
                            progress: 0,
                            renderProgress: 100,
                            totalFrames: 100,
                            message: "Copying to clipboard...",
                            mediaPath: media.path,
                            stage: "rendering",
                          });

                          await commands.copyVideoToClipboard(outputPath);
                        } catch (error) {
                          console.log(
                            "Need to render video with progress:",
                            error
                          );
                          const progress = new Channel<RenderProgress>();
                          progress.onmessage = (p) => {
                            console.log("Progress channel message:", p);
                            if (
                              p.type === "FrameRendered" &&
                              progressState.type === "copying"
                            ) {
                              console.log(
                                "Frame rendered:",
                                p.current_frame,
                                "Total frames:",
                                progressState.totalFrames
                              );
                              setProgressState({
                                ...progressState,
                                message: "Rendering video...",
                                renderProgress: p.current_frame,
                              });
                            }
                            if (
                              p.type === "EstimatedTotalFrames" &&
                              progressState.type === "copying"
                            ) {
                              console.log("Got total frames:", p.total_frames);
                              setProgressState({
                                ...progressState,
                                totalFrames: p.total_frames,
                              });
                            }
                          };

                          outputPath = await commands.renderVideoWithProgress(
                            mediaId,
                            presets.getDefaultConfig() ??
                              DEFAULT_PROJECT_CONFIG,
                            progress
                          );
                          console.log("Video rendered, copying to clipboard");
                          await commands.copyVideoToClipboard(outputPath);
                        }
                      } else {
                        // For screenshots, show quick progress animation
                        setProgressState({
                          type: "copying",
                          progress: 50,
                          renderProgress: 100,
                          totalFrames: 100,
                          message: "Copying image to clipboard...",
                          mediaPath: media.path,
                          stage: "rendering",
                        });
                        await commands.copyScreenshotToClipboard(media.path);
                      }

                      setProgressState({
                        type: "copying",
                        progress: 100,
                        renderProgress: 100,
                        totalFrames: 100,
                        message: "Copied successfully!",
                        mediaPath: media.path,
                        stage: "rendering",
                      });

                      setTimeout(() => {
                        setProgressState({ type: "idle" });
                      }, 1500);
                    } catch (error) {
                      console.error("Error in copy media:", error);
                      setProgressState({ type: "idle" });
                      throw error;
                    }
                  },
                }));

                const saveMedia = createMutation(() => ({
                  mutationFn: async () => {
                    setProgressState({
                      type: "saving",
                      progress: 0,
                      renderProgress: 0,
                      totalFrames: 0,
                      message: isRecording
                        ? "Choose where to save video..."
                        : "Choose where to save image...",
                      mediaPath: media.path,
                      stage: "rendering",
                    });

                    try {
                      const meta = recordingMeta.data;
                      if (!meta) {
                        throw new Error("Recording metadata not available");
                      }

                      const defaultName = isRecording
                        ? "Cap Recording"
                        : media.path.split(".cap/")[1];
                      const suggestedName = meta.pretty_name || defaultName;

                      const fileType = isRecording ? "recording" : "screenshot";
                      const extension = isRecording ? ".mp4" : ".png";

                      const fullFileName = suggestedName.endsWith(extension)
                        ? suggestedName
                        : `${suggestedName}${extension}`;

                      const savePath = await commands.saveFileDialog(
                        fullFileName,
                        fileType
                      );

                      if (!savePath) {
                        setProgressState({ type: "idle" });
                        return false;
                      }

                      if (isRecording) {
                        let outputPath: string;

                        try {
                          // First try to get existing rendered video
                          outputPath = await commands.getRenderedVideo(
                            mediaId,
                            presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
                          );
                          console.log("Using existing rendered video");

                          // Show quick progress animation for existing video
                          setProgressState({
                            type: "saving",
                            progress: 0,
                            renderProgress: 100,
                            totalFrames: 100,
                            message: "Saving video...",
                            mediaPath: media.path,
                            stage: "rendering",
                          });
                        } catch (error) {
                          // If it doesn't exist, render with progress
                          console.log("Need to render video:", error);
                          const progress = new Channel<RenderProgress>();
                          progress.onmessage = (p) => {
                            console.log("Progress channel message:", p);
                            if (
                              p.type === "FrameRendered" &&
                              progressState.type === "saving"
                            ) {
                              console.log(
                                "Frame rendered:",
                                p.current_frame,
                                "Total frames:",
                                progressState.totalFrames
                              );
                              setProgressState({
                                ...progressState,
                                message: "Rendering video...",
                                renderProgress: p.current_frame,
                              });
                            }
                            if (
                              p.type === "EstimatedTotalFrames" &&
                              progressState.type === "saving"
                            ) {
                              console.log("Got total frames:", p.total_frames);
                              setProgressState({
                                ...progressState,
                                totalFrames: p.total_frames,
                              });
                            }
                          };

                          outputPath = await commands.renderVideoWithProgress(
                            mediaId,
                            presets.getDefaultConfig() ??
                              DEFAULT_PROJECT_CONFIG,
                            progress
                          );
                        }

                        // Show copying progress
                        setProgressState({
                          type: "saving",
                          progress: 50,
                          renderProgress: 100,
                          totalFrames: 100,
                          message: "Copying file...",
                          mediaPath: media.path,
                          stage: "rendering",
                        });

                        await commands.copyFileToPath(outputPath, savePath);
                      } else {
                        // For screenshots, show quick progress animation
                        setProgressState({
                          type: "saving",
                          progress: 50,
                          renderProgress: 0,
                          totalFrames: 0,
                          message: "Saving image...",
                          mediaPath: media.path,
                          stage: "rendering",
                        });

                        await commands.copyFileToPath(media.path, savePath);
                      }

                      setProgressState({
                        type: "saving",
                        progress: 100,
                        renderProgress: 100,
                        totalFrames: 100,
                        message: "Saved successfully!",
                        mediaPath: media.path,
                        stage: "rendering",
                      });

                      setTimeout(() => {
                        setProgressState({ type: "idle" });
                      }, 1500);

                      return true;
                    } catch (error) {
                      setProgressState({ type: "idle" });
                      throw error;
                    }
                  },
                }));
                const uploadMedia = createMutation(() => ({
                  mutationFn: async () => {
                    if (recordingMeta.data?.sharing) {
                      setProgressState({
                        type: "copying",
                        progress: 100,
                        message: "Link copied to clipboard!",
                        mediaPath: media.path,
                      });

                      setTimeout(() => {
                        setProgressState({ type: "idle" });
                      }, 1500);

                      return;
                    }

                    const isUpgraded = await commands.checkUpgradedAndUpdate();
                    if (!isUpgraded) {
                      await commands.openUpgradeWindow();
                      return;
                    }

                    setProgressState({
                      type: "uploading",
                      renderProgress: 0,
                      uploadProgress: 0,
                      message: "Preparing to render...",
                      mediaPath: media.path,
                      stage: "rendering",
                    });

                    try {
                      let res: UploadResult;
                      if (isRecording) {
                        let outputPath: string;
                        try {
                          // First try to get existing rendered video
                          outputPath = await commands.getRenderedVideo(
                            mediaId,
                            presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
                          );
                          console.log("Using existing rendered video");

                          // Show quick progress animation for existing video
                          setProgressState({
                            type: "uploading",
                            renderProgress: 100,
                            uploadProgress: 0,
                            message: "Starting upload...",
                            mediaPath: media.path,
                            stage: "uploading",
                          });
                        } catch (error) {
                          // If it doesn't exist, render with progress
                          console.log(
                            "Need to render video with progress:",
                            error
                          );
                          const progress = new Channel<RenderProgress>();
                          progress.onmessage = (p) => {
                            console.log("Progress channel message:", p);
                            if (
                              p.type === "FrameRendered" &&
                              progressState.type === "uploading"
                            ) {
                              console.log(
                                "Frame rendered:",
                                p.current_frame,
                                "Total frames:",
                                progressState.totalFrames
                              );
                              setProgressState({
                                ...progressState,
                                message: "Rendering video...",
                                renderProgress: progressState.totalFrames
                                  ? Math.round(
                                      (p.current_frame /
                                        progressState.totalFrames) *
                                        100
                                    )
                                  : 0,
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

                          outputPath = await commands.renderVideoWithProgress(
                            mediaId,
                            presets.getDefaultConfig() ??
                              DEFAULT_PROJECT_CONFIG,
                            progress
                          );
                        }

                        res = await commands.uploadRenderedVideo(
                          mediaId,
                          presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG,
                          null
                        );
                      } else {
                        res = await commands.uploadScreenshot(media.path);
                      }

                      switch (res) {
                        case "NotAuthenticated":
                          throw new Error("Not authenticated");
                        case "PlanCheckFailed":
                          throw new Error("Plan check failed");
                        case "UpgradeRequired":
                          setProgressState({ type: "idle" });
                          setShowUpgradeTooltip(true);
                          return;
                        default:
                          break;
                      }
                    } catch (error) {
                      setProgressState({ type: "idle" });
                      throw error;
                    }
                  },
                  onSuccess: () =>
                    startTransition(() => recordingMeta.refetch()),
                }));

                const [metadata] = createResource(async () => {
                  if (isRecording) {
                    const result = await commands
                      .getVideoMetadata(media.path, null)
                      .catch((e) => {
                        console.error(`Failed to get metadata: ${e}`);
                      });
                    if (!result) return;

                    const [duration, size] = result;
                    console.log(
                      `Metadata for ${media.path}: duration=${duration}, size=${size}`
                    );

                    return { duration, size };
                  }
                  return null;
                });

                const [imageExists, setImageExists] = createSignal(true);
                const [showUpgradeTooltip, setShowUpgradeTooltip] =
                  createSignal(false);

                const isLoading = () =>
                  copyMedia.isPending ||
                  saveMedia.isPending ||
                  uploadMedia.isPending;

                createFakeWindowBounds(ref, () => media.path);

                return (
                  <Suspense>
                    <div
                      ref={setRef}
                      style={{ "border-color": "rgba(255, 255, 255, 0.2)" }}
                      class={cx(
                        "w-[260px] h-[150px] p-[0.1875rem] bg-gray-500/50 rounded-[12px] overflow-hidden shadow border-[1px] group relative",
                        "transition-all duration-300",
                        media.isNew && "ring-2 ring-blue-500 ring-opacity-75"
                      )}
                    >
                      <div
                        class={cx(
                          "w-full h-full flex relative bg-transparent rounded-[8px] border-[1px] overflow-hidden z-10",
                          "transition-all",
                          isLoading() && "backdrop-blur bg-gray-500/80"
                        )}
                        style={{
                          "border-color": "rgba(255, 255, 255, 0.2)",
                          "pointer-events": "auto",
                        }}
                      >
                        <Show
                          when={imageExists()}
                          fallback={
                            <div class="pointer-events-none w-[105%] h-[105%] absolute inset-0 -z-10 bg-gray-400" />
                          }
                        >
                          <img
                            class="pointer-events-none w-[105%] h-[105%] object-cover absolute inset-0 -z-10"
                            alt="media preview"
                            src={`${convertFileSrc(
                              isRecording
                                ? `${media.path}/screenshots/display.jpg`
                                : `${media.path}`
                            )}?t=${Date.now()}`}
                            onError={() => setImageExists(false)}
                          />
                        </Show>

                        <Show
                          when={
                            progressState.type !== "idle" &&
                            progressState.mediaPath === media.path
                          }
                        >
                          <div class="absolute inset-0 bg-gray-500/95 flex items-center justify-center z-[999999] pointer-events-auto">
                            <div class="w-[80%] text-center">
                              <h3 class="text-sm font-medium mb-3 text-gray-50">
                                <Switch>
                                  <Match
                                    when={
                                      progressState.type === "copying" &&
                                      progressState
                                    }
                                  >
                                    {(state) => (
                                      <h3 class="text-sm font-medium mb-3 text-gray-50">
                                        {isRecording
                                          ? state().stage === "rendering"
                                            ? "Rendering video"
                                            : "Copying to clipboard"
                                          : "Copying image to clipboard"}
                                      </h3>
                                    )}
                                  </Match>
                                  <Match
                                    when={
                                      progressState.type === "saving" &&
                                      progressState
                                    }
                                  >
                                    {(state) => (
                                      <h3 class="text-sm font-medium mb-3 text-gray-50">
                                        {isRecording
                                          ? state().stage === "rendering"
                                            ? "Rendering video"
                                            : "Saving video"
                                          : "Saving image"}
                                      </h3>
                                    )}
                                  </Match>
                                  <Match
                                    when={
                                      progressState.type === "uploading" &&
                                      progressState
                                    }
                                  >
                                    {(state) => (
                                      <h3 class="text-sm font-medium mb-3 text-gray-50">
                                        {state().stage === "rendering"
                                          ? "Rendering video"
                                          : "Creating shareable link"}
                                      </h3>
                                    )}
                                  </Match>
                                </Switch>
                              </h3>

                              <div class="w-full bg-gray-200/20 rounded-full h-2.5 mb-2">
                                <div
                                  class="bg-blue-300 h-2.5 rounded-full transition-all duration-200"
                                  style={{
                                    width: `${(() => {
                                      if (
                                        !progressState ||
                                        progressState.type === "idle"
                                      )
                                        return 0;

                                      if (progressState.type === "uploading") {
                                        return progressState.stage ===
                                          "rendering"
                                          ? Math.min(
                                              progressState.renderProgress || 0,
                                              100
                                            )
                                          : Math.min(
                                              progressState.uploadProgress || 0,
                                              100
                                            );
                                      }

                                      if (progressState.stage === "rendering") {
                                        return Math.min(
                                          ((progressState.renderProgress || 0) /
                                            (progressState.totalFrames || 1)) *
                                            100,
                                          100
                                        );
                                      }

                                      return Math.min(
                                        progressState.progress || 0,
                                        100
                                      );
                                    })()}%`,
                                  }}
                                />
                              </div>

                              <p class="text-xs text-gray-50 mt-2">
                                {"message" in progressState
                                  ? progressState.message
                                  : undefined}
                              </p>
                            </div>
                          </div>
                        </Show>

                        <div
                          class={cx(
                            "w-full h-full absolute inset-0 transition-all duration-150 pointer-events-auto",
                            isLoading() || showUpgradeTooltip()
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                            "backdrop-blur bg-gray-500/80 text-white p-2"
                          )}
                        >
                          <TooltipIconButton
                            class="absolute left-3 top-3 z-20"
                            tooltipText="Close"
                            tooltipPlacement="right"
                            onClick={() => {
                              const setMedia = isRecording
                                ? setRecordings
                                : setScreenshots;
                              setMedia(
                                produce((state) => {
                                  const index = state.findIndex(
                                    (entry) => entry.path === media.path
                                  );
                                  if (index !== -1) {
                                    state.splice(index, 1);
                                  }
                                })
                              );
                            }}
                          >
                            <IconCapCircleX class="size-[1rem]" />
                          </TooltipIconButton>
                          {isRecording ? (
                            <TooltipIconButton
                              class="absolute left-3 bottom-3 z-20"
                              tooltipText="Edit"
                              tooltipPlacement="right"
                              onClick={() => {
                                const setMedia = isRecording
                                  ? setRecordings
                                  : setScreenshots;
                                setMedia(
                                  produce((state) => {
                                    const index = state.findIndex(
                                      (entry) => entry.path === media.path
                                    );
                                    if (index !== -1) {
                                      state.splice(index, 1);
                                    }
                                  })
                                );
                                commands.openEditor(mediaId);
                              }}
                            >
                              <IconCapEditor class="size-[1rem]" />
                            </TooltipIconButton>
                          ) : (
                            <TooltipIconButton
                              class="absolute left-3 bottom-3 z-20"
                              tooltipText="View"
                              tooltipPlacement="right"
                              onClick={() => {
                                commands.openFilePath(media.path);
                              }}
                            >
                              <IconLucideEye class="size-[1rem]" />
                            </TooltipIconButton>
                          )}
                          <TooltipIconButton
                            class="absolute right-3 top-3 z-20"
                            tooltipText={
                              copyMedia.isPending
                                ? "Copying to Clipboard"
                                : "Copy to Clipboard"
                            }
                            tooltipPlacement="left"
                            onClick={() => copyMedia.mutate()}
                            disabled={
                              saveMedia.isPending || uploadMedia.isPending
                            }
                          >
                            <Switch
                              fallback={<IconCapCopy class="size-[1rem]" />}
                            >
                              <Match when={copyMedia.isPending}>
                                <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
                              </Match>
                              <Match when={copyMedia.isSuccess}>
                                {(_) => {
                                  setTimeout(() => {
                                    if (!copyMedia.isPending) copyMedia.reset();
                                  }, 2000);

                                  return (
                                    <IconLucideCheck class="size-[1rem]" />
                                  );
                                }}
                              </Match>
                            </Switch>
                          </TooltipIconButton>
                          <TooltipIconButton
                            class="absolute right-3 bottom-3 z-[998]"
                            tooltipText={
                              recordingMeta.data?.sharing
                                ? "Copy Shareable Link"
                                : uploadMedia.isPending
                                ? "Uploading Cap"
                                : showUpgradeTooltip()
                                ? "Upgrade Required"
                                : "Create Shareable Link"
                            }
                            tooltipPlacement="left"
                            onClick={() => {
                              uploadMedia.mutate();
                            }}
                            disabled={
                              copyMedia.isPending ||
                              saveMedia.isPending ||
                              recordingMeta.isLoading ||
                              recordingMeta.isError
                            }
                          >
                            <Switch
                              fallback={<IconCapUpload class="size-[1rem]" />}
                            >
                              <Match when={uploadMedia.isPending}>
                                <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
                              </Match>
                              <Match when={uploadMedia.isSuccess}>
                                {(_) => {
                                  setTimeout(() => {
                                    if (!uploadMedia.isPending)
                                      uploadMedia.reset();
                                  }, 2000);

                                  return (
                                    <IconLucideCheck class="size-[1rem]" />
                                  );
                                }}
                              </Match>
                            </Switch>
                          </TooltipIconButton>
                          <div class="absolute inset-0 flex items-center justify-center">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => saveMedia.mutate()}
                              disabled={
                                copyMedia.isPending || uploadMedia.isPending
                              }
                            >
                              <Switch fallback="Save">
                                <Match when={saveMedia.isPending}>
                                  Saving...
                                </Match>
                                <Match
                                  when={
                                    saveMedia.isSuccess &&
                                    saveMedia.data === true
                                  }
                                >
                                  {(_) => {
                                    setTimeout(() => {
                                      if (!saveMedia.isPending)
                                        saveMedia.reset();
                                    }, 2000);

                                    return "Saved!";
                                  }}
                                </Match>
                              </Switch>
                            </Button>
                          </div>
                        </div>
                        <Show when={isRecording && metadata()}>
                          {(metadata) => (
                            <div
                              style={{ color: "white", "font-size": "14px" }}
                              class={cx(
                                "absolute bottom-0 left-0 right-0 font-medium bg-gray-500 bg-opacity-40 backdrop-blur p-2 flex justify-between items-center pointer-events-none transition-all",
                                isLoading() || showUpgradeTooltip()
                                  ? "opacity-0"
                                  : "group-hover:opacity-0"
                              )}
                            >
                              <p class="flex items-center">
                                <IconCapCamera class="w-[20px] h-[20px] mr-1" />
                                {Math.floor(metadata().duration / 60)}:
                                {Math.floor(metadata().duration % 60)
                                  .toString()
                                  .padStart(2, "0")}
                              </p>
                              <p>{metadata().size.toFixed(2)} MB</p>
                            </div>
                          )}
                        </Show>
                      </div>
                    </div>
                  </Suspense>
                );
              }}
            </For>
          </TransitionGroup>
        </div>
      </div>
    </div>
  );
}

const IconButton = (props: ComponentProps<"button">) => {
  return (
    <button
      {...props}
      type="button"
      class={cx(
        "p-[0.325rem] bg-gray-100 rounded-full text-neutral-300 text-[12px] shadow-[0px 2px 4px rgba(18, 22, 31, 0.12)]",
        props.class
      )}
    />
  );
};

const TooltipIconButton = (
  props: ComponentProps<"button"> & {
    tooltipText: string;
    tooltipPlacement: string;
  }
) => {
  const [isOpen, setIsOpen] = createSignal(false);

  return (
    <Tooltip
      placement={props.tooltipPlacement as "top" | "bottom" | "left" | "right"}
      openDelay={0}
      closeDelay={0}
      open={isOpen()}
      onOpenChange={setIsOpen}
      hoverableContent={false}
      floatingOptions={{
        offset: 10,
        flip: true,
        shift: true,
      }}
    >
      <Tooltip.Trigger as={IconButton} {...props}>
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          class="p-2 font-medium"
          style={{
            "background-color": "rgba(255, 255, 255, 0.1)",
            color: "white",
            "border-radius": "8px",
            "font-size": "12px",
            "z-index": "15",
          }}
        >
          {props.tooltipText}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
};

function createFakeWindowBounds(
  ref: () => HTMLElement | undefined | null,
  key: Accessor<string>
) {
  const bounds = createElementBounds(ref);

  createEffect(() => {
    commands.setFakeWindowBounds(key(), {
      x: bounds.left ?? 0,
      y: bounds.top ?? 0,
      width: bounds.width ?? 0,
      height: bounds.height ?? 0,
    });
  });

  onCleanup(() => {
    commands.removeFakeWindow(key());
  });
}
