import { createMutation, createQuery } from "@tanstack/solid-query";
import { Channel, convertFileSrc } from "@tauri-apps/api/core";
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
import { createStore, produce, SetStoreFunction } from "solid-js/store";
import IconLucideClock from "~icons/lucide/clock";

import { commands, events, RenderProgress, UploadResult } from "~/utils/tauri";
import { createPresets } from "~/utils/createPresets";
import { FPS, OUTPUT_SIZE } from "./editor/context";
import { authStore, generalSettingsStore } from "~/store";

type MediaEntry = {
  path: string;
  prettyName: string;
  isNew: boolean;
  type?: "recording" | "screenshot";
};

export default function () {
  onMount(() => {
    document.documentElement.setAttribute("data-transparent-window", "true");
    document.body.style.background = "transparent";
  });

  const [recordings, setRecordings] = makePersisted(
    createStore<MediaEntry[]>([]),
    { name: "recordings-store" }
  );
  const [screenshots, setScreenshots] = makePersisted(
    createStore<MediaEntry[]>([]),
    { name: "screenshots-store" }
  );

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
      <div class="w-full relative left-0 bottom-0 flex flex-col-reverse pl-[40px] pb-[80px] gap-4 h-full overflow-y-auto scrollbar-none">
        <div class="pt-12 w-full flex flex-col gap-4">
          <TransitionGroup
            enterToClass="translate-y-0"
            enterClass="opacity-0 translate-y-4"
            exitToClass="opacity-0 -translate-x-1/2 ease-out"
            exitClass="opacity-100 translate-x-0"
            exitActiveClass="absolute"
          >
            <For each={allMedia()}>
              {(media) => {
                const [ref, setRef] = createSignal<HTMLElement | null>(null);
                const normalizedPath = media.path.replace(/\\/g, "/");
                const mediaId = normalizedPath.split("/").pop()?.split(".")[0]!;

                const type = media.type ?? "recording";
                const isRecording = type !== "screenshot";

                const { copy, save, upload, actionState } =
                  createRecordingMutations(media, (e) => {
                    if (e === "upgradeRequired") setShowUpgradeTooltip(true);
                  });

                const [metadata] = createResource(async () => {
                  if (!isRecording) return null;

                  const result = await commands
                    .getVideoMetadata(media.path, null)
                    .catch((e) => {
                      console.error(`Failed to get metadata: ${e}`);
                    });
                  if (!result) return;

                  const { duration, size } = result;
                  // Calculate estimated export time (rough estimation: 1.5x real-time for 1080p)
                  const estimatedExportTime = Math.ceil(duration * 1.5);
                  console.log(
                    `Metadata for ${media.path}: duration=${duration}, size=${size}, estimatedExport=${estimatedExportTime}`
                  );

                  return { duration, size, estimatedExportTime };
                });

                const [imageExists, setImageExists] = createSignal(true);
                const [showUpgradeTooltip, setShowUpgradeTooltip] =
                  createSignal(false);

                const isLoading = () =>
                  copy.isPending || save.isPending || upload.isPending;

                createFakeWindowBounds(ref, () => media.path);

                const fileId =
                  type === "recording"
                    ? mediaId
                    : normalizedPath
                        .split("screenshots/")[1]
                        .split("/")[0]
                        .replace(".cap", "");

                const recordingMeta = createQuery(() => ({
                  queryKey: ["recordingMeta", fileId],
                  queryFn: () => commands.getRecordingMeta(fileId, type),
                }));

                return (
                  <Suspense>
                    <div
                      ref={setRef}
                      style={{ "border-color": "rgba(255, 255, 255, 0.1)" }}
                      class={cx(
                        "w-[260px] h-[150px] bg-gray-500/40 rounded-xl border-[1px] overflow-hidden shadow group relative transition-all duration-300"
                      )}
                    >
                      <div
                        class={cx(
                          "w-full h-full flex relative bg-transparent z-10 overflow-hidden transition-all",
                          isLoading() && "backdrop-blur bg-gray-500/80"
                        )}
                        style={{
                          "pointer-events": "auto",
                        }}
                      >
                        <Show
                          when={imageExists()}
                          fallback={
                            <div class="pointer-events-none w-full h-full absolute inset-0 -z-10 bg-gray-400" />
                          }
                        >
                          <img
                            class="pointer-events-none w-full h-full object-cover absolute inset-0 -z-10 rounded-[7.4px]"
                            alt="media preview"
                            src={`${convertFileSrc(
                              isRecording
                                ? `${media.path}/screenshots/display.jpg`
                                : `${media.path}`
                            )}?t=${Date.now()}`}
                            onError={() => setImageExists(false)}
                          />
                        </Show>

                        <Switch>
                          <Match
                            when={
                              actionState.type === "copy" && actionState.state
                            }
                            keyed
                          >
                            {(state) => (
                              <ActionProgressOverlay
                                title={
                                  state.type === "rendering"
                                    ? "Rendering video"
                                    : state.type === "copying"
                                    ? "Copying to clipboard"
                                    : "Copied to clipboard"
                                }
                                progressPercentage={actionProgressPercentage(
                                  actionState
                                )}
                              />
                            )}
                          </Match>
                          <Match
                            when={
                              actionState.type === "save" && actionState.state
                            }
                            keyed
                          >
                            {(state) => (
                              <ActionProgressOverlay
                                title={(() => {
                                  if (state.type === "choosing-location")
                                    return "Preparing";

                                  if (isRecording) {
                                    if (state.type === "rendering")
                                      return "Rendering video";
                                    if (state.type === "saving")
                                      return "Saving video";
                                    return "Saved video";
                                  } else {
                                    if (state.type === "rendering")
                                      return "Rendering image";
                                    if (state.type === "saving")
                                      return "Saving image";
                                    return "Saved image";
                                  }
                                })()}
                                progressPercentage={actionProgressPercentage(
                                  actionState
                                )}
                                progressMessage={
                                  state.type === "choosing-location" &&
                                  `Choose where to ${
                                    isRecording ? "export video" : "save image"
                                  }...`
                                }
                              />
                            )}
                          </Match>
                          <Match
                            when={
                              actionState.type === "upload" && actionState.state
                            }
                            keyed
                          >
                            {(state) => (
                              <ActionProgressOverlay
                                title={
                                  state.type === "rendering"
                                    ? "Rendering video"
                                    : state.type === "uploading"
                                    ? "Creating shareable link"
                                    : "Shareable link copied"
                                }
                                progressPercentage={actionProgressPercentage(
                                  actionState
                                )}
                              />
                            )}
                          </Match>
                        </Switch>

                        <div
                          style={{
                            "background-color": "rgba(0, 0, 0, 0.4)",
                          }}
                          class={cx(
                            "absolute inset-0 transition-all duration-150 pointer-events-auto rounded-[7.4px] dark:text-gray-100",
                            showUpgradeTooltip()
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                            "backdrop-blur p-2"
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
                              copy.isPending
                                ? "Copying to Clipboard"
                                : "Copy to Clipboard"
                            }
                            tooltipPlacement="left"
                            onClick={() => copy.mutate()}
                          >
                            <IconCapCopy class="size-[1rem]" />
                          </TooltipIconButton>
                          <TooltipIconButton
                            class="absolute right-3 bottom-3 z-[998]"
                            tooltipText={
                              recordingMeta.data?.sharing
                                ? "Copy Shareable Link"
                                : "Create Shareable Link"
                            }
                            tooltipPlacement="left"
                            onClick={() => upload.mutate()}
                          >
                            <IconCapUpload class="size-[1rem]" />
                          </TooltipIconButton>
                          <div class="absolute inset-0 flex items-center justify-center">
                            <Button
                              variant="white"
                              size="sm"
                              onClick={() => save.mutate()}
                            >
                              Export
                            </Button>
                          </div>
                        </div>
                        <Show when={metadata.latest}>
                          {(metadata) => (
                            <div
                              style={{
                                "font-size": "12px",
                                "border-end-end-radius": "7.4px",
                                "border-end-start-radius": "7.4px",
                              }}
                              class={cx(
                                "absolute bottom-0 left-0 right-0 font-medium text-gray-200 dark:text-gray-500 bg-[#00000080] backdrop-blur-lg px-3 py-2 flex justify-between items-center pointer-events-none transition-all max-w-full overflow-hidden",
                                isLoading() || showUpgradeTooltip()
                                  ? "opacity-0"
                                  : "group-hover:opacity-0"
                              )}
                            >
                              <span class="flex items-center">
                                <IconCapCamera class="w-[16px] h-[16px] mr-1.5" />
                                {Math.floor(metadata().duration / 60)}:
                                {Math.floor(metadata().duration % 60)
                                  .toString()
                                  .padStart(2, "0")}
                              </span>
                              <span class="flex items-center">
                                <IconLucideHardDrive class="w-[16px] h-[16px] mr-1.5" />
                                {metadata().size.toFixed(2)} MB
                              </span>
                              <span class="flex items-center">
                                <IconLucideClock class="w-[16px] h-[16px] mr-1.5" />
                                ~
                                {Math.floor(
                                  metadata().estimatedExportTime / 60
                                )}
                                :
                                {Math.floor(metadata().estimatedExportTime % 60)
                                  .toString()
                                  .padStart(2, "0")}
                              </span>
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

function ActionProgressOverlay(props: {
  title: string;
  // percentage 0-100
  progressPercentage: number;
  progressMessage?: string | false;
}) {
  return (
    <div
      style={{
        "background-color": "rgba(0, 0, 0, 0.85)",
      }}
      class="absolute inset-0 flex items-center justify-center z-[999999] pointer-events-auto"
    >
      <div class="w-[80%] text-center">
        <h3 class="text-sm font-medium mb-3 text-gray-50 dark:text-gray-500">
          {props.title}
        </h3>
        <div class="w-full bg-gray-400 rounded-full h-2.5 mb-2">
          <div
            class="bg-blue-300 text-gray-50 dark:text-gray-500 h-2.5 rounded-full transition-all duration-200"
            style={{
              width: `${Math.max(0, Math.min(100, props.progressPercentage))}%`,
            }}
          />
        </div>

        <p class="text-xs text-gray-50 dark:text-gray-500 mt-2">
          {typeof props.progressMessage === "string"
            ? props.progressMessage
            : `${Math.floor(props.progressPercentage)}%`}
        </p>
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
        "p-[0.325rem] bg-gray-50 dark:bg-gray-500 rounded-full text-[12px] shadow-[0px 2px 4px rgba(18, 22, 31, 0.12)]",
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
          class="py-1.5 px-2 font-medium"
          style={{
            "background-color": "rgba(255, 255, 255, 0.85)",
            color: "black",
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

function createRecordingMutations(
  media: MediaEntry,
  onEvent: (e: "upgradeRequired") => void
) {
  const presets = createPresets();

  const normalizedPath = media.path.replace(/\\/g, "/");
  const mediaId = normalizedPath.split("/").pop()?.split(".")[0]!;
  const type = media.type ?? "recording";
  const isRecording = type !== "screenshot";

  const fileId =
    type === "recording"
      ? mediaId
      : normalizedPath
          .split("screenshots/")[1]
          .split("/")[0]
          .replace(".cap", "");

  const recordingMeta = createQuery(() => ({
    queryKey: ["recordingMeta", fileId],
    queryFn: () => commands.getRecordingMeta(fileId, type),
  }));

  const copy = createMutation(() => ({
    mutationFn: async () => {
      setActionState({
        type: "copy",
        state: { type: "rendering", state: { type: "starting" } },
      });

      try {
        if (isRecording) {
          const progress = createRenderProgressChannel("copy", setActionState);

          // First try to get existing rendered video
          const outputPath = await commands.exportVideo(
            mediaId,
            progress,
            false,
            FPS,
            OUTPUT_SIZE
          );

          // Show quick progress animation for existing video
          setActionState(
            produce((s) => {
              if (
                s.type === "copy" &&
                s.state.type === "rendering" &&
                s.state.state.type === "rendering"
              )
                s.state.state.renderedFrames = s.state.state.totalFrames;
            })
          );

          await commands.copyVideoToClipboard(outputPath);
        } else {
          // For screenshots, show quick progress animation
          setActionState({
            type: "copy",
            state: { type: "copying" },
          });
          await commands.copyScreenshotToClipboard(media.path);
        }

        setActionState({
          type: "copy",
          state: { type: "copied" },
        });
      } catch (error) {
        console.error("Error in copy media:", error);
        throw error;
      }
    },
    onSuccess() {
      setTimeout(() => {
        setActionState({ type: "idle" });
      }, 2000);
    },
  }));

  const save = createMutation(() => ({
    mutationFn: async () => {
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

      setActionState({
        type: "save",
        state: {
          type: "choosing-location",
          mediaType: isRecording ? "video" : "screenshot",
        },
      });

      const savePath = await commands.saveFileDialog(fullFileName, fileType);

      if (!savePath) {
        setActionState({ type: "idle" });
        return false;
      }

      setActionState({
        type: "save",
        state: {
          type: "rendering",
          state: { type: "starting" },
        },
      });

      if (isRecording) {
        const progress = createRenderProgressChannel("save", setActionState);

        // Always force re-render when saving
        const outputPath = await commands.exportVideo(
          mediaId,
          progress,
          true, // Force re-render
          FPS,
          OUTPUT_SIZE
        );

        await commands.copyFileToPath(outputPath, savePath);
      } else {
        // For screenshots, show quick progress animation
        setActionState({ type: "save", state: { type: "saving" } });

        await commands.copyFileToPath(media.path, savePath);
      }

      setActionState({ type: "save", state: { type: "saved" } });

      return true;
    },
    onSettled() {
      setTimeout(() => {
        setActionState({ type: "idle" });
      }, 2000);
    },
  }));

  const upload = createMutation(() => ({
    mutationFn: async () => {
      if (recordingMeta.data?.sharing) {
        setActionState({ type: "upload", state: { type: "link-copied" } });

        await commands.writeClipboardString(recordingMeta.data.sharing.link);

        return;
      }

      // Check authentication first
      const existingAuth = await authStore.get();
      if (!existingAuth) {
        await commands.showWindow("SignIn");
        throw new Error("You need to sign in to share recordings");
      }

      const metadata = await commands.getVideoMetadata(media.path, null);
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
        setActionState(
          produce((actionState) => {
            if (
              actionState.type !== "upload" ||
              actionState.state.type !== "uploading"
            )
              return;

            actionState.state.progress = Math.round(
              event.payload.progress * 100
            );
          })
        );
      });

      try {
        let res: UploadResult;
        if (isRecording) {
          setActionState({
            type: "upload",
            state: { type: "rendering", state: { type: "starting" } },
          });

          const progress = createRenderProgressChannel(
            "upload",
            setActionState
          );

          // First try to get existing rendered video
          await commands.exportVideo(
            mediaId,
            progress,
            false,
            FPS,
            OUTPUT_SIZE
          );
          console.log("Using existing rendered video");

          // Show quick progress animation for existing video
          setActionState(
            produce((s) => {
              if (
                s.type === "copy" &&
                s.state.type === "rendering" &&
                s.state.state.type === "rendering"
              )
                s.state.state.renderedFrames = s.state.state.totalFrames;
            })
          );

          setActionState({
            type: "upload",
            state: { type: "uploading", progress: 0 },
          });

          res = await commands.uploadExportedVideo(mediaId, {
            Initial: { pre_created_video: null },
          });
        } else {
          setActionState({
            type: "upload",
            state: { type: "uploading", progress: 0 },
          });

          res = await commands.uploadScreenshot(media.path);
        }

        switch (res) {
          case "NotAuthenticated":
            throw new Error("Not authenticated");
          case "PlanCheckFailed":
            throw new Error("Plan check failed");
          case "UpgradeRequired":
            onEvent("upgradeRequired");
            return;
          default:
            break;
        }
      } finally {
        unlisten();
      }

      setActionState({ type: "upload", state: { type: "link-copied" } });
    },
    onSettled() {
      setTimeout(() => {
        setActionState({ type: "idle" });
      }, 2000);
    },
    onSuccess: () => startTransition(() => recordingMeta.refetch()),
  }));

  const [actionState, setActionState] = createStore<ActionState>({
    type: "idle",
  });

  return { copy, save, upload, actionState };
}

type ActionState =
  | { type: "idle" }
  | {
      type: "copy";
      state:
        | { type: "rendering"; state: RenderState }
        | { type: "copying" }
        | { type: "copied" };
    }
  | {
      type: "save";
      state:
        | { type: "choosing-location"; mediaType: "video" | "screenshot" }
        | { type: "rendering"; state: RenderState }
        | { type: "saving" }
        | { type: "saved" };
    }
  | {
      type: "upload";
      state:
        | { type: "rendering"; state: RenderState }
        | {
            type: "uploading";
            // 0-100
            progress: number;
          }
        | { type: "link-copied" };
    };

function createRenderProgressChannel(
  actionType: Exclude<ActionState["type"], "idle">,
  setActionState: SetStoreFunction<ActionState>
) {
  const progress = new Channel<RenderProgress>();

  progress.onmessage = (msg) => {
    setActionState(
      produce((progressState) => {
        if (
          progressState.type !== actionType ||
          progressState.state.type !== "rendering"
        )
          return;

        const renderState = progressState.state.state;

        if (
          msg.type === "EstimatedTotalFrames" &&
          renderState.type === "starting"
        )
          progressState.state.state = {
            type: "rendering",
            renderedFrames: 0,
            totalFrames: msg.total_frames,
          };
        else if (
          msg.type === "FrameRendered" &&
          renderState.type === "rendering"
        )
          renderState.renderedFrames = msg.current_frame;
      })
    );
  };

  return progress;
}

function actionProgressPercentage(state: ActionState): number {
  function renderPercentage(state: RenderState) {
    if (state.type === "starting") return 0;
    else
      return Math.floor(
        Math.min((state.renderedFrames / state.totalFrames) * 100, 100)
      );
  }

  if (state.type === "idle") return 0;

  if (state.state.type === "rendering")
    return renderPercentage(state.state.state);

  switch (state.type) {
    case "copy": {
      return state.state.type === "copied" ? 100 : 50;
    }
    case "save": {
      if (state.state.type === "choosing-location") return 0;
      return state.state.type === "saved" ? 100 : 50;
    }
    case "upload": {
      if (state.state.type === "link-copied") return 100;
      return state.state.progress;
    }
  }
}

type RenderState =
  | {
      type: "rendering";
      renderedFrames: number;
      totalFrames: number;
    }
  | { type: "starting" };
