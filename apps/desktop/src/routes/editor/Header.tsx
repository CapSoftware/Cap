import { Button } from "@cap/ui-solid";
import { cx } from "cva";
import {
  Match,
  Show,
  Switch,
  createResource,
  onCleanup,
  onMount,
} from "solid-js";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createStore, reconcile } from "solid-js/store";
import { Tooltip } from "@kobalte/core";

import { type RenderProgress, commands } from "~/utils/tauri";

import { useEditorContext } from "./context";
import { Dialog, DialogContent } from "./ui";
import {
  ProgressState,
  progressState,
  setProgressState,
} from "~/store/progress";
import { events } from "~/utils/tauri";

export function Header() {
  let unlistenTitlebar: () => void | undefined;

  onMount(async () => {
    unlistenTitlebar = await initializeTitlebar();
  });

  onCleanup(() => {
    unlistenTitlebar?.();
  });

  setTitlebar("border", false);
  setTitlebar("height", "4rem");
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
        <ShareButton />
        <ExportButton />
      </div>
    </div>
  );

  return (
    <>
      <Titlebar />
      <Dialog.Root
        open={progressState.type !== "idle"}
        onOpenChange={() => { }} // Empty handler prevents closing
      >
        <DialogContent
          title={
            progressState.type === "copying"
              ? "Link Copied"
              : progressState.type === "uploading"
                ? "Creating Shareable Link"
                : "Exporting Recording"
          }
          confirm={<></>}
        >
          <Switch>
            <Match when={progressState.type === "copying"}>
              {(when) => {
                const state = progressState as Extract<
                  ProgressState,
                  { type: "copying" }
                >;
                return (
                  <div class="w-[80%] text-center mx-auto">
                    <h3 class="text-sm font-medium mb-3 text-gray-50">
                      {state.stage === "rendering"
                        ? "Rendering video"
                        : "Copying to clipboard"}
                    </h3>

                    <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                      <div
                        class="bg-blue-300 h-2.5 rounded-full transition-all duration-200"
                        style={{
                          width: `${state.stage === "rendering"
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

                    <p class="text-xs text-gray-50 mt-2">{state.message}</p>
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
                  <div class="w-[80%] text-center mx-auto">
                    <h3 class="text-sm font-medium mb-3 text-gray-50">
                      {state.stage === "rendering"
                        ? "Rendering video"
                        : "Saving file"}
                    </h3>

                    <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                      <div
                        class="bg-blue-300 h-2.5 rounded-full transition-all duration-200"
                        style={{
                          width: `${state.stage === "rendering"
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

                    <p class="text-xs text-gray-50 mt-2">{state.message}</p>
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
                  <div class="w-[80%] text-center mx-auto">
                    <h3 class="text-sm font-medium mb-3 text-gray-50">
                      {state.stage === "rendering"
                        ? "Rendering video"
                        : "Creating shareable link"}
                    </h3>

                    <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                      <div
                        class="bg-blue-300 h-2.5 rounded-full transition-all duration-200"
                        style={{
                          width: `${state.stage === "rendering"
                            ? Math.min(state.renderProgress || 0, 100)
                            : Math.min(state.uploadProgress || 0, 100)
                            }%`,
                        }}
                      />
                    </div>

                    <p class="text-xs text-gray-50 mt-2">{state.message}</p>
                  </div>
                );
              }}
            </Match>
          </Switch>
        </DialogContent>
      </Dialog.Root>
    </>
  );
}

import { Channel } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import { createMutation } from "@tanstack/solid-query";
import Titlebar from "~/components/titlebar/Titlebar";
import { initializeTitlebar, setTitlebar } from "~/utils/titlebar-state";

function ExportButton() {
  const { videoId, project, prettyName } = useEditorContext();

  return (
    <>
      <Button
        variant="primary"
        size="md"
        onClick={() => {
          save({
            filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
            defaultPath: `~/Desktop/${prettyName()}.mp4`,
          }).then((p) => {
            if (!p) return;

            setProgressState({
              type: "saving",
              progress: 0,
              renderProgress: 0,
              totalFrames: 0,
              message: "Preparing to render...",
              mediaPath: p,
              stage: "rendering",
            });

            const progress = new Channel<RenderProgress>();
            progress.onmessage = (p) => {
              if (
                p.type === "FrameRendered" &&
                progressState.type === "saving"
              ) {
                setProgressState({
                  ...progressState,
                  renderProgress: p.current_frame,
                });
              }
              if (
                p.type === "EstimatedTotalFrames" &&
                progressState.type === "saving"
              ) {
                setProgressState({
                  ...progressState,
                  totalFrames: p.total_frames,
                });
              }
            };

            return commands
              .renderToFile(p, videoId, project, progress)
              .then(() => {
                setProgressState({
                  type: "saving",
                  progress: 100,
                  message: "Saved successfully!",
                  mediaPath: p,
                });

                setTimeout(() => {
                  setProgressState({ type: "idle" });
                }, 1500);
              });
          });
        }}
      >
        Export
      </Button>
    </>
  );
}

function ShareButton() {
  const { videoId, project, presets } = useEditorContext();
  const [recordingMeta, metaActions] = createResource(() =>
    commands.getRecordingMeta(videoId, "recording")
  );

  const uploadVideo = createMutation(() => ({
    mutationFn: async () => {
      if (!recordingMeta()) return;

      if (recordingMeta()?.sharing) {
        // Use reupload for existing shares
        return await commands.reuploadRenderedVideo(
          videoId,
          project
            ? project
            : presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
        );
      }

      setProgressState({
        type: "uploading",
        renderProgress: 0,
        uploadProgress: 0,
        message: "Preparing to render...",
        mediaPath: videoId,
        stage: "rendering",
        totalFrames: 0,
      });

      // Listen for upload progress events
      const unlisten = await events.uploadProgress.listen(
        (event: {
          payload: { stage: string; progress: number; message: string };
        }) => {
          if (progressState.type === "uploading") {
            if (event.payload.stage === "rendering") {
              setProgressState({
                type: "uploading",
                renderProgress: Math.round(event.payload.progress * 100),
                uploadProgress: 0,
                message: event.payload.message,
                mediaPath: videoId,
                stage: "rendering",
                totalFrames: progressState.totalFrames,
              });
            } else {
              setProgressState({
                type: "uploading",
                renderProgress: 100,
                uploadProgress: Math.round(event.payload.progress * 100),
                message: event.payload.message,
                mediaPath: videoId,
                stage: "uploading",
                totalFrames: progressState.totalFrames,
              });
            }
          }
        }
      );

      try {
        const result = await commands.uploadRenderedVideo(
          videoId,
          project
            ? project
            : presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG,
          null
        );

        unlisten();

        if (result === "NotAuthenticated") {
          throw new Error("Not authenticated");
        }
        if (result === "PlanCheckFailed") {
          throw new Error("Plan check failed");
        }
        if (result === "UpgradeRequired") {
          throw new Error("Upgrade required");
        }

        return result;
      } catch (error) {
        unlisten();
        setProgressState({ type: "idle" });
        throw error;
      }
    },
    onSuccess: () => {
      metaActions.refetch();
      // Don't immediately set to idle - let the progress show for a moment
      setTimeout(() => {
        setProgressState({ type: "idle" });
      }, 1500);
    },
    onError: (error) => {
      console.error("Upload error:", error);
      setProgressState({ type: "idle" });
    },
  }));

  return (
    <Show
      when={recordingMeta()?.sharing}
      fallback={
        <Button
          disabled={uploadVideo.isPending}
          onClick={() => uploadVideo.mutate()}
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
                  onClick={() => uploadVideo.mutate()}
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
