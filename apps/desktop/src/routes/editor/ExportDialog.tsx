import { Button } from "@cap/ui-solid";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  JSX,
  Show,
} from "solid-js";

import { Select as KSelect } from "@kobalte/core/select";
import { createMutation } from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import { createStore, produce } from "solid-js/store";
import Tooltip from "~/components/Tooltip";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { commands, events, RenderProgress } from "~/utils/tauri";
import { metaUpdateStore, useEditorContext } from "./context";
import { RESOLUTION_OPTIONS, ResolutionOption } from "./Header";
import {
  DialogContent,
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
} from "./ui";
import { createProgressBar } from "./utils";

export const COMPRESSION_OPTIONS = [
  { label: "Studio", value: "studio" },
  { label: "Social Media", value: "social" },
  { label: "Web", value: "web" },
  { label: "Web (Low)", value: "web_low" },
] as const;

export const FPS_OPTIONS = [
  { label: "30 FPS", value: 30 },
  { label: "60 FPS", value: 60 },
] satisfies Array<{ label: string; value: number }>;

export const EXPORT_TO_OPTIONS = [
  {
    label: "File",
    value: "file",
    icon: <IconCapFile class="text-gray-500 size-4" />,
  },
  {
    label: "Clipboard",
    value: "clipboard",
    icon: <IconCapCopy class="text-gray-500 size-4" />,
  },
  {
    label: "Shareable link",
    value: "link",
    icon: <IconCapLink class="text-gray-500 size-4" />,
  },
] as const;

export const FORMAT_OPTIONS = [
  { label: "MP4", value: "mp4" },
  { label: "GIF", value: "gif", disabled: true },
] as { label: string; value: string; disabled?: boolean }[];

type ExportToOption = (typeof EXPORT_TO_OPTIONS)[number]["value"];

type ExportState =
  | { type: "idle" }
  | { type: "starting" }
  | { type: "rendering"; renderedFrames: number; totalFrames: number }
  | { type: "saving"; done: boolean };

type CopyState =
  | { type: "idle" }
  | { type: "starting" }
  | { type: "rendering"; renderedFrames: number; totalFrames: number }
  | { type: "copying" }
  | { type: "copied" };

const ExportDialog = () => {
  const { videoId, prettyName, setDialog } = useEditorContext();
  const [format, setFormat] = createSignal(
    localStorage.getItem("cap-export-format") || "mp4"
  );
  const [copyPressed, setCopyPressed] = createSignal(false);

  const [selectedFps, setSelectedFps] = createSignal(
    Number(localStorage.getItem("cap-export-fps") || 30)
  );
  const [exportTo, setExportTo] = createSignal<ExportToOption>(
    (localStorage.getItem("cap-export-to") as ExportToOption) || "file"
  );
  const [selectedResolution, setSelectedResolution] =
    createSignal<ResolutionOption>(
      RESOLUTION_OPTIONS.find(
        (opt) => opt.value === localStorage.getItem("cap-export-resolution")
      ) || RESOLUTION_OPTIONS[0]
    );
  const [compression, setCompression] = createSignal(
    localStorage.getItem("cap-export-compression") || "social"
  );
  const [uploadComplete, setUploadComplete] = createSignal(false);

  createEffect(() => {
    localStorage.setItem("cap-export-format", format());
    localStorage.setItem("cap-export-to", exportTo());
    localStorage.setItem("cap-export-fps", selectedFps().toString());
    localStorage.setItem("cap-export-resolution", selectedResolution().value);
    localStorage.setItem("cap-export-compression", compression());
  });

  const selectedStyle =
    "ring-1 ring-offset-2 ring-offset-gray-200 bg-gray-300 ring-gray-500";

  const [exportEstimates] = createResource(
    () => ({
      videoId,
      resolution: {
        x: selectedResolution().width,
        y: selectedResolution().height,
      },
      fps: selectedFps(),
    }),
    (params) =>
      commands.getExportEstimates(params.videoId, params.resolution, params.fps)
  );
  const exportButtonIcon: Record<"file" | "clipboard" | "link", JSX.Element> = {
    file: <IconCapFile class="text-gray-500 size-4" />,
    clipboard: <IconCapCopy class="text-gray-500 size-4" />,
    link: <IconCapLink class="text-gray-500 size-4" />,
  };

  const [exportState, setExportState] = createStore<ExportState>({
    type: "idle",
  });

  const [copyState, setCopyState] = createStore<CopyState>({
    type: "idle",
  });

  const copy = createMutation(() => ({
    mutationFn: async () => {
      setCopyState({
        type: "starting",
      });

      try {
        const progress = new Channel<RenderProgress>();

        progress.onmessage = (msg) => {
          if (msg.type === "EstimatedTotalFrames")
            setCopyState({
              type: "rendering",
              renderedFrames: 0,
              totalFrames: msg.total_frames,
            });
          else
            setCopyState(
              produce((state) => {
                if (msg.type === "FrameRendered" && state.type === "rendering")
                  state.renderedFrames = msg.current_frame;
              })
            );
        };

        // First try to get existing rendered video
        const outputPath = await commands.exportVideo(
          videoId,
          progress,
          false,
          selectedFps(),
          {
            x: selectedResolution().width,
            y: selectedResolution().height,
          }
        );

        // Show quick progress animation for existing video
        setCopyState(
          produce((s) => {
            if (s.type === "rendering") s.renderedFrames = s.totalFrames;
          })
        );

        await commands.copyVideoToClipboard(outputPath);
      } catch (error) {
        console.error("Error in copy media:", error);
        throw error;
      }
    },
    onSuccess() {
      setCopyState({
        type: "copied",
      });
      setTimeout(() => {
        setCopyState({ type: "idle" });
      }, 2000);
    },
  }));

  const [recordingMeta, metaActions] = createResource(() =>
    commands.getRecordingMeta(videoId, "recording")
  );

  const exportWithSettings = createMutation(() => ({
    mutationFn: async () => {
      setExportState({ type: "idle" });

      const path = await save({
        filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
        defaultPath: `~/Desktop/${prettyName()}.mp4`,
      });
      if (!path) return;

      trackEvent("export_started", {
        resolution: selectedResolution().value,
        fps: selectedFps(),
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
          selectedFps(),
          {
            x: selectedResolution().width,
            y: selectedResolution().height,
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
        setDialog((d) => ({ ...d, open: false }));
      }, 1000);
    },
  }));

  createProgressBar(() => {
    if (exportWithSettings.isIdle || exportState.type === "idle") return;
    if (exportState.type === "starting") return 0;
    if (exportState.type === "rendering")
      return (exportState.renderedFrames / exportState.totalFrames) * 100;
    return 100;
  });

  const [uploadState, setUploadState] = createStore<
    | { type: "idle" }
    | { type: "starting" }
    | { type: "rendering"; renderedFrames: number; totalFrames: number }
    | { type: "uploading"; progress: number }
    | { type: "link-copied" }
  >({ type: "idle" });

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
        resolution: selectedResolution().value,
        fps: selectedFps(),
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

        await commands.exportVideo(videoId, progress, true, selectedFps(), {
          x: selectedResolution().width,
          y: selectedResolution().height,
        });

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
      setUploadComplete(true);
      metaUpdateStore.notifyUpdate(videoId);
    },
    onError: (error) => {
      commands.globalMessageDialog(
        error instanceof Error ? error.message : "Failed to upload recording"
      );
    },
    onSettled() {
      setTimeout(() => {
        uploadVideo.reset();
      }, 2000);
    },
  }));

  createProgressBar(() => {
    if (uploadVideo.isIdle || uploadState.type === "idle") return;
    if (uploadState.type === "starting") return 0;
    if (uploadState.type === "rendering")
      return (uploadState.renderedFrames / uploadState.totalFrames) * 100;
    if (uploadState.type === "uploading") return uploadState.progress;
    return 100;
  });

  return (
    <>
      <Show
        when={
          exportState.type === "idle" &&
          uploadState.type === "idle" &&
          copyState.type === "idle"
        }
      >
        <DialogContent
          title="Export"
          confirm={
            <Button
              class="flex gap-2 items-center"
              variant="primary"
              onClick={() => {
                if (exportTo() === "file") {
                  exportWithSettings.mutate();
                } else if (exportTo() === "link") {
                  uploadVideo.mutate();
                } else {
                  copy.mutate();
                }
              }}
            >
              {exportButtonIcon[exportTo()]} Export to {exportTo()}
            </Button>
          }
          leftFooterContent={
            <div>
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
                          const totalSeconds = Math.round(
                            est().duration_seconds
                          );
                          const hours = Math.floor(totalSeconds / 3600);
                          const minutes = Math.floor(
                            (totalSeconds % 3600) / 60
                          );
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
                          const minutes = Math.floor(
                            (totalSeconds % 3600) / 60
                          );
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
          }
        >
          <div class="flex flex-wrap gap-3">
            {/* Format */}
            <div class="p-4 bg-gray-100 rounded-xl">
              <div class="flex flex-col gap-3">
                <h3 class="text-gray-500">Format</h3>
                <div class="flex flex-row gap-2">
                  <For each={FORMAT_OPTIONS}>
                    {(option) =>
                      option.disabled ? (
                        <Tooltip content={"Coming soon"}>
                          <Button
                            variant="secondary"
                            onClick={() => setFormat(option.value)}
                            disabled={option.disabled}
                            class={cx(
                              format() === option.value && selectedStyle
                            )}
                          >
                            {option.label}
                          </Button>
                        </Tooltip>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={() => setFormat(option.value)}
                          autofocus={false}
                          class={cx(format() === option.value && selectedStyle)}
                        >
                          {option.label}
                        </Button>
                      )
                    }
                  </For>
                </div>
              </div>
            </div>
            {/* Frame rate */}
            <div class="overflow-hidden relative p-4 bg-gray-100 rounded-xl">
              <div class="flex flex-col gap-3">
                <h3 class="text-gray-500">Frame rate</h3>
                <KSelect
                  options={FPS_OPTIONS}
                  optionValue="value"
                  optionTextValue="label"
                  placeholder="Select FPS"
                  value={FPS_OPTIONS.find((opt) => opt.value === selectedFps())}
                  onChange={(option) => {
                    const fps = option?.value ?? 30;
                    trackEvent("export_fps_changed", {
                      fps: fps,
                    });
                    setSelectedFps(fps);
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
                  <KSelect.Trigger class="flex flex-row gap-2 items-center px-3 w-full h-10 bg-gray-200 rounded-xl transition-colors disabled:text-gray-400">
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
            </div>
            {/* Export to */}
            <div class="flex-1 p-4 bg-gray-100 rounded-xl">
              <div class="flex flex-col gap-3">
                <h3 class="text-gray-500">Export to</h3>
                <div class="flex gap-2">
                  <For each={EXPORT_TO_OPTIONS}>
                    {(option) => (
                      <Button
                        onClick={() => setExportTo(option.value)}
                        class={cx(
                          "flex gap-2 items-center",
                          exportTo() === option.value && selectedStyle
                        )}
                        variant="secondary"
                      >
                        {option.icon}
                        {option.label}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </div>
            {/* Compression */}
            <div class="p-4 bg-gray-100 rounded-xl">
              <div class="flex flex-col gap-3">
                <h3 class="text-gray-400">Compression (Coming Soon)</h3>
                <div class="flex gap-2">
                  <For each={COMPRESSION_OPTIONS}>
                    {(option) => (
                      <Button
                        onClick={() => setCompression(option.value)}
                        variant="secondary"
                        disabled
                      >
                        {option.label}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </div>
            {/* Resolution */}
            <div class="flex-1 p-4 bg-gray-100 rounded-xl">
              <div class="flex flex-col gap-3">
                <h3 class="text-gray-500">Resolution</h3>
                <div class="flex gap-2">
                  <For each={RESOLUTION_OPTIONS}>
                    {(option) => (
                      <Button
                        class={cx(
                          "flex-1",
                          selectedResolution().value === option.value &&
                            selectedStyle
                        )}
                        variant="secondary"
                        onClick={() => setSelectedResolution(option)}
                      >
                        {option.label}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Show>
      <Show
        when={
          exportState.type !== "idle" ||
          uploadState.type !== "idle" ||
          copyState.type !== "idle"
        }
      >
        <DialogContent
          title={"Export"}
          confirm={
            <Show when={uploadComplete()}>
              <div class="relative">
                <a
                  href={recordingMeta()?.sharing?.link}
                  target="_blank"
                  rel="noreferrer"
                  class="block"
                >
                  <Button
                    variant="lightdark"
                    class="flex gap-2 justify-center items-center"
                  >
                    <p>Open Link</p>
                    <div class="size-6" />{" "}
                    {/* Placeholder for the copy button */}
                  </Button>
                </a>
                {/* Absolutely positioned copy button that sits on top */}
                <Tooltip
                  childClass="absolute right-4 top-1/2 transform -translate-y-1/2"
                  content="Copy link"
                >
                  <div
                    onClick={() => {
                      setCopyPressed(true);
                      setTimeout(() => {
                        setCopyPressed(false);
                      }, 2000);
                      navigator.clipboard.writeText(
                        recordingMeta()?.sharing?.link!
                      );
                    }}
                    class="flex justify-center items-center rounded-lg transition-colors duration-300 cursor-pointer bg-gray-450 group hover:bg-gray-400 size-6"
                  >
                    {!copyPressed() ? (
                      <IconCapCopy class="size-2.5 text-gray-50 group-hover:text-gray-500 transition-colors duration-300" />
                    ) : (
                      <IconLucideCheck class="size-2.5 svgpathanimation text-gray-50 group-hover:text-gray-500 transition-colors duration-300" />
                    )}
                  </div>
                </Tooltip>
              </div>
            </Show>
          }
          close={
            <Show when={uploadComplete()}>
              <Button
                onClick={() => {
                  setUploadComplete(false);
                  setUploadState({ type: "idle" });
                }}
                variant="secondary"
                class="flex gap-2 justify-center h-[44px] items-center"
              >
                Back
              </Button>
            </Show>
          }
          class="text-gray-500 bg-gray-600 dark:text-gray-500"
        >
          <div class="relative z-10 px-5 py-4 mx-auto space-y-6 w-full text-center">
            {/** Upload success */}
            <Show when={uploadComplete()}>
              <UploadingSuccessContent />
            </Show>
            {/** Copying to clipboard */}
            <Show when={copyState.type !== "idle"}>
              <CopyingContent copyState={copyState} />
            </Show>
            {/** Exporting to shareable link */}
            <Show when={uploadState.type !== "idle" && uploadVideo.isPending}>
              <UploadingCapContent />
            </Show>
            {/** Exporting to file */}
            <Show when={exportState.type !== "idle"}>
              <ExportingFileContent exportState={exportState} />
            </Show>
          </div>
        </DialogContent>
      </Show>
    </>
  );
};

const CopyingContent = ({ copyState }: { copyState: CopyState }) => {
  return (
    <div class="flex justify-center items-center h-full">
      <h1 class="text-lg font-medium text-gray-500">
        {copyState.type === "rendering"
          ? "Rendering video..."
          : copyState.type === "starting"
          ? "Copying to clipboard..."
          : "Copied to clipboard"}
      </h1>
      <Show when={copyState.type === "rendering"}>
        <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
          <div
            class="bg-blue-300 h-2.5 rounded-full"
            style={{
              width: `${
                copyState.type === "rendering"
                  ? Math.min(
                      (copyState.renderedFrames / copyState.totalFrames) * 100,
                      100
                    )
                  : 0
              }%`,
            }}
          />
        </div>
      </Show>
      <p class="mt-2 text-xs text-gray-500">
        {copyState.type === "rendering"
          ? `${Math.floor(
              (copyState.renderedFrames / copyState.totalFrames) * 100
            )}%`
          : ""}
      </p>
    </div>
  );
};

const ExportingFileContent = ({
  exportState,
}: {
  exportState: ExportState;
}) => {
  return (
    <>
      <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
        <div
          class="bg-blue-300 h-2.5 rounded-full"
          style={{
            width: `${
              exportState.type === "saving"
                ? 100
                : exportState.type === "rendering"
                ? Math.min(
                    (exportState.renderedFrames / exportState.totalFrames) *
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
    </>
  );
};

const UploadingSuccessContent = () => {
  return (
    <div class="flex flex-col gap-5 justify-center items-center">
      <div class="flex flex-col gap-1 items-center">
        <h1 class="mx-auto text-lg font-medium text-center text-gray-500">
          Upload Complete
        </h1>
        <p class="text-sm text-gray-400">
          Your Cap has been uploaded successfully
        </p>
      </div>
    </div>
  );
};

const UploadingCapContent = () => {
  return (
    <div class="flex gap-2 justify-center items-center">
      <IconLucideLoaderCircle class="animate-spin size-7" />
      <h1 class="text-lg font-medium text-center text-gray-500">
        Uploading Cap
      </h1>
    </div>
  );
};

export default ExportDialog;
