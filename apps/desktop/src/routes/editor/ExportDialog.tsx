import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import {
  createMutation,
  createQuery,
  keepPreviousData,
} from "@tanstack/solid-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
  createEffect,
  createRoot,
  createSignal,
  For,
  JSX,
  Match,
  on,
  Show,
  Switch,
  ValidComponent,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { makePersisted } from "@solid-primitives/storage";
import toast from "solid-toast";

import Tooltip from "~/components/Tooltip";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { commands, events } from "~/utils/tauri";
import { RenderState, useEditorContext } from "./context";
import { RESOLUTION_OPTIONS } from "./Header";
import {
  DialogContent,
  MenuItem,
  MenuItemList,
  PopperContent,
  topSlideAnimateClasses,
} from "./ui";
import { exportVideo, COMPRESSION_QUALITY } from "~/utils/export";
import type { CompressionQuality } from "~/utils/tauri";

export const COMPRESSION_OPTIONS = [
  { label: "Studio", value: COMPRESSION_QUALITY.Studio },
  { label: "Social Media", value: COMPRESSION_QUALITY.Social },
  { label: "Web", value: COMPRESSION_QUALITY.Web },
  { label: "Web (Low)", value: COMPRESSION_QUALITY.WebLow },
] as const;

export const FPS_OPTIONS = [
  { label: "15 FPS", value: 15 },
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

export function ExportDialog() {
  const {
    dialog,
    setDialog,
    editorInstance,
    setExportState,
    exportState,
    meta,
    refetchMeta,
  } = useEditorContext();

  const [settings, setSettings] = makePersisted(
    createStore({
      format: "mp4" as "mp4" | "gif",
      fps: 30,
      exportTo: "file" as ExportToOption,
      resolution: { label: "720p", value: "720p", width: 1280, height: 720 },
      compression: COMPRESSION_QUALITY.Web as CompressionQuality,
    }),
    { name: "export_settings" }
  );

  const selectedStyle =
    "ring-1 ring-offset-2 ring-offset-gray-200 bg-gray-300 ring-gray-500";

  const projectPath = editorInstance.path;

  const exportEstimates = createQuery(() => ({
    // prevents flicker when modifying settings
    placeholderData: keepPreviousData,
    queryKey: [
      "exportEstimates",
      {
        resolution: {
          x: settings.resolution.width,
          y: settings.resolution.height,
        },
        fps: settings.fps,
      },
    ] as const,
    queryFn: ({ queryKey: [_, { resolution, fps }] }) =>
      commands.getExportEstimates(projectPath, resolution, fps),
  }));

  const exportButtonIcon: Record<"file" | "clipboard" | "link", JSX.Element> = {
    file: <IconCapFile class="text-solid-white size-4" />,
    clipboard: <IconCapCopy class="text-solid-white size-4" />,
    link: <IconCapLink class="text-solid-white size-4" />,
  };

  const copy = createMutation(() => ({
    mutationFn: async () => {
      if (exportState.type !== "idle") return;
      setExportState(reconcile({ action: "copy", type: "starting" }));

      const { fps, resolution } = settings;
      const outputPath = await exportVideo(
        projectPath,
        {
          fps: settings.fps,
          resolution_base: { x: resolution.width, y: resolution.height },
          compression: settings.compression,
        },
        (progress) => setExportState({ type: "rendering", progress })
      );

      setExportState({ type: "copying" });

      await commands.copyVideoToClipboard(outputPath);
    },
    onError: (error) => {
      commands.globalMessageDialog(
        error instanceof Error ? error.message : "Failed to copy recording"
      );
      setExportState(reconcile({ type: "idle" }));
    },
    onSuccess() {
      setExportState({ type: "done" });

      if (dialog().open) {
        const closeTimeout = setTimeout(() => {
          setDialog((d) => ({ ...d, open: false }));
        }, 2000);

        createRoot((dispose) => {
          createEffect(
            on(
              () => dialog().open,
              () => {
                clearTimeout(closeTimeout);

                dispose();
              },
              { defer: true }
            )
          );
        });
      } else toast.success("Recording exported to clipboard");
    },
  }));

  const save = createMutation(() => ({
    mutationFn: async () => {
      if (exportState.type !== "idle") return;
      setExportState(reconcile({ action: "save", type: "starting" }));

      const outputPath = await saveDialog({
        filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
        defaultPath: `~/Desktop/${meta.prettyName}.mp4`,
      });
      if (!outputPath) return;

      trackEvent("export_started", {
        resolution: settings.resolution,
        fps: settings.fps,
        path: outputPath,
      });

      setExportState({ type: "starting" });

      const videoPath = await exportVideo(
        projectPath,
        {
          fps: settings.fps,
          resolution_base: {
            x: settings.resolution.width,
            y: settings.resolution.height,
          },
          compression: settings.compression,
        },
        (progress) => {
          setExportState({ type: "rendering", progress });
        }
      );

      setExportState({ type: "copying" });

      await commands.copyFileToPath(videoPath, outputPath);
    },
    onError: (error) => {
      commands.globalMessageDialog(
        error instanceof Error ? error.message : "Failed to export recording"
      );
      setExportState({ type: "idle" });
    },
    onSuccess() {
      setExportState({ type: "done" });

      if (dialog().open) {
        const closeTimeout = setTimeout(() => {
          setDialog((d) => ({ ...d, open: false }));
        }, 2000);

        createRoot((dispose) => {
          createEffect(
            on(
              () => dialog().open,
              () => {
                clearTimeout(closeTimeout);

                dispose();
              },
              { defer: true }
            )
          );
        });
      } else toast.success("Recording exported to file");
    },
  }));

  const upload = createMutation(() => ({
    mutationFn: async () => {
      if (exportState.type !== "idle") return;
      setExportState(reconcile({ action: "upload", type: "starting" }));

      // Check authentication first
      const existingAuth = await authStore.get();
      if (!existingAuth)
        throw new Error("You need to sign in to share recordings");

      trackEvent("create_shareable_link_clicked", {
        resolution: settings.resolution,
        fps: settings.fps,
        has_existing_auth: !!existingAuth,
      });

      const metadata = await commands.getVideoMetadata(projectPath);
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
        setExportState(
          produce((state) => {
            if (state.type !== "uploading") return;

            state.progress = Math.round(event.payload.progress * 100);
          })
        );
      });

      try {
        await exportVideo(
          projectPath,
          {
            fps: settings.fps,
            resolution_base: {
              x: settings.resolution.width,
              y: settings.resolution.height,
            },
            compression: settings.compression,
          },
          (progress) => setExportState({ type: "rendering", progress })
        );

        setExportState({ type: "uploading", progress: 0 });

        // Now proceed with upload
        const result = meta.sharing
          ? await commands.uploadExportedVideo(projectPath, "Reupload")
          : await commands.uploadExportedVideo(projectPath, {
              Initial: { pre_created_video: null },
            });

        if (result === "NotAuthenticated")
          throw new Error("You need to sign in to share recordings");
        else if (result === "PlanCheckFailed")
          throw new Error("Failed to verify your subscription status");
        else if (result === "UpgradeRequired")
          throw new Error("This feature requires an upgraded plan");
      } finally {
        unlisten();
      }
    },
    onSuccess: () => {
      const d = dialog();
      if ("type" in d && d.type === "export") setDialog({ ...d, open: true });

      refetchMeta();

      setExportState({ type: "done" });
    },
    onError: (error) => {
      commands.globalMessageDialog(
        error instanceof Error ? error.message : "Failed to upload recording"
      );

      setExportState(reconcile({ type: "idle" }));
    },
  }));

  return (
    <>
      <Show when={exportState.type === "idle"}>
        <DialogContent
          title="Export"
          confirm={
            <Button
              class="flex gap-2 items-center"
              variant="primary"
              onClick={() => {
                if (settings.exportTo === "file") save.mutate();
                else if (settings.exportTo === "link") upload.mutate();
                else copy.mutate();
              }}
            >
              {exportButtonIcon[settings.exportTo]} Export to{" "}
              {settings.exportTo}
            </Button>
          }
          leftFooterContent={
            <div>
              <Show when={exportEstimates.data}>
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
                            onClick={() =>
                              setSettings(
                                "format",
                                option.value as "mp4" | "gif"
                              )
                            }
                            disabled={option.disabled}
                            autofocus={false}
                            class={cx(
                              settings.format === option.value && selectedStyle
                            )}
                          >
                            {option.label}
                          </Button>
                        </Tooltip>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setSettings("format", option.value as "mp4")
                          }
                          autofocus={false}
                          class={cx(
                            settings.format === option.value && selectedStyle
                          )}
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
                  value={FPS_OPTIONS.find((opt) => opt.value === settings.fps)}
                  onChange={(option) => {
                    const value = option?.value ?? 30;
                    trackEvent("export_fps_changed", {
                      fps: value,
                    });
                    setSettings("fps", value);
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
                    <KSelect.Icon<ValidComponent>
                      as={(props) => (
                        <IconCapChevronDown
                          {...props}
                          class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]"
                        />
                      )}
                    />
                  </KSelect.Trigger>
                  <KSelect.Portal>
                    <PopperContent<typeof KSelect.Content>
                      as={KSelect.Content}
                      class={cx(topSlideAnimateClasses, "z-50")}
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
                        onClick={() => setSettings("exportTo", option.value)}
                        class={cx(
                          "flex gap-2 items-center",
                          settings.exportTo === option.value && selectedStyle
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
                <h3 class="text-gray-500">Compression</h3>
                <div class="flex gap-2">
                  <For each={COMPRESSION_OPTIONS}>
                    {(option) => (
                      <Button
                        onClick={() => {
                          setSettings(
                            "compression",
                            option.value as CompressionQuality
                          );
                        }}
                        variant="secondary"
                        class={cx(
                          settings.compression === option.value && selectedStyle
                        )}
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
                  <For
                    each={[
                      RESOLUTION_OPTIONS._720p,
                      RESOLUTION_OPTIONS._1080p,
                      RESOLUTION_OPTIONS._4k,
                    ]}
                  >
                    {(option) => (
                      <Button
                        class={cx(
                          "flex-1",
                          settings.resolution.value === option.value
                            ? selectedStyle
                            : ""
                        )}
                        variant="secondary"
                        onClick={() => setSettings("resolution", option)}
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
      <Show when={exportState.type !== "idle" && exportState} keyed>
        {(exportState) => {
          const [copyPressed, setCopyPressed] = createSignal(false);

          return (
            <DialogContent
              title={"Export"}
              confirm={
                <Show
                  when={
                    exportState.action === "upload" &&
                    exportState.type === "done"
                  }
                >
                  <div class="relative">
                    <a
                      href={meta.sharing?.link}
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
                          navigator.clipboard.writeText(meta.sharing?.link!);
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
                <Show
                  when={
                    exportState.action === "upload" &&
                    exportState.type === "done"
                  }
                >
                  <Button
                    onClick={() => {
                      setDialog((d) => ({ ...d, open: false }));
                    }}
                    variant="secondary"
                    class="flex gap-2 justify-center h-[44px] items-center"
                  >
                    Close
                  </Button>
                </Show>
              }
              class="text-gray-500 bg-gray-600 dark:text-gray-500"
            >
              <div class="relative z-10 px-5 py-4 mx-auto space-y-6 w-full text-center">
                <Switch>
                  <Match
                    when={exportState.action === "copy" && exportState}
                    keyed
                  >
                    {(copyState) => (
                      <div class="flex flex-col gap-4 justify-center items-center h-full">
                        <h1 class="text-lg font-medium text-gray-500">
                          {copyState.type === "starting"
                            ? "Preparing..."
                            : copyState.type === "rendering"
                            ? "Rendering video..."
                            : copyState.type === "copying"
                            ? "Copying to clipboard..."
                            : "Copied to clipboard"}
                        </h1>
                        <Show
                          when={
                            (copyState.type === "rendering" ||
                              copyState.type === "starting") &&
                            copyState
                          }
                          keyed
                        >
                          {(copyState) => <RenderProgress state={copyState} />}
                        </Show>
                      </div>
                    )}
                  </Match>
                  <Match
                    when={exportState.action === "save" && exportState}
                    keyed
                  >
                    {(saveState) => (
                      <div class="flex flex-col gap-4 justify-center items-center h-full">
                        <h1 class="text-lg font-medium text-gray-500">
                          {saveState.type === "starting"
                            ? "Preparing..."
                            : saveState.type === "rendering"
                            ? "Rendering video..."
                            : saveState.type === "copying"
                            ? "Exporting to file..."
                            : "Exported successfully"}
                        </h1>
                        <Show
                          when={
                            (saveState.type === "rendering" ||
                              saveState.type === "starting") &&
                            saveState
                          }
                          keyed
                        >
                          {(copyState) => <RenderProgress state={copyState} />}
                        </Show>
                      </div>
                    )}
                  </Match>
                  <Match
                    when={exportState.action === "upload" && exportState}
                    keyed
                  >
                    {(uploadState) => (
                      <Switch>
                        <Match
                          when={uploadState.type !== "done" && uploadState}
                          keyed
                        >
                          {(uploadState) => (
                            <div class="flex flex-col gap-4 justify-center items-center">
                              <h1 class="text-lg font-medium text-center text-gray-500">
                                Uploading Cap...
                              </h1>
                              <Switch>
                                <Match
                                  when={
                                    uploadState.type === "uploading" &&
                                    uploadState
                                  }
                                  keyed
                                >
                                  {(uploadState) => (
                                    <ProgressView
                                      amount={uploadState.progress}
                                      label={`Uploading - ${Math.floor(
                                        uploadState.progress
                                      )}%`}
                                    />
                                  )}
                                </Match>
                                <Match
                                  when={
                                    uploadState.type !== "uploading" &&
                                    uploadState
                                  }
                                  keyed
                                >
                                  {(renderState) => (
                                    <RenderProgress state={renderState} />
                                  )}
                                </Match>
                              </Switch>
                            </div>
                          )}
                        </Match>
                        <Match when={uploadState.type === "done"}>
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
                        </Match>
                      </Switch>
                    )}
                  </Match>
                </Switch>
              </div>
            </DialogContent>
          );
        }}
      </Show>
    </>
  );
}

function RenderProgress(props: { state: RenderState }) {
  return (
    <ProgressView
      amount={
        props.state.type === "rendering"
          ? (props.state.progress.renderedCount /
              props.state.progress.totalFrames) *
            100
          : 0
      }
      label={
        props.state.type === "rendering"
          ? `Rendering video (${props.state.progress.renderedCount}/${props.state.progress.totalFrames} frames)`
          : "Preparing to render..."
      }
    />
  );
}

function ProgressView(props: { amount: number; label?: string }) {
  return (
    <>
      <div class="w-full bg-gray-200 rounded-full h-2.5">
        <div
          class="bg-blue-300 h-2.5 rounded-full"
          style={{ width: `${props.amount}%` }}
        />
      </div>
      <p class="text-xs tabular-nums">{props.label}</p>
    </>
  );
}
