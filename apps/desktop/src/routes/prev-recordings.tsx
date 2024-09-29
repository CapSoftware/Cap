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
} from "solid-js";
import Tooltip from "@corvu/tooltip";
import { Button } from "@cap/ui-solid";
import { createElementBounds } from "@solid-primitives/bounds";
import { TransitionGroup } from "solid-transition-group";
import { createStore, produce } from "solid-js/store";
import { makePersisted } from "@solid-primitives/storage";

import { commands, events } from "~/utils/tauri";
import { DEFAULT_PROJECT_CONFIG } from "./editor/projectConfig";
import { createPresets } from "~/utils/createPresets";

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

  // Listen for new recordings
  events.newRecordingAdded.listen((event) => {
    addMediaEntry(event.payload.path, "recording");
  });

  // Listen for new screenshots
  events.newScreenshotAdded.listen((event) => {
    addMediaEntry(event.payload.path, "screenshot");
  });

  const allMedia = createMemo(() => [...recordings, ...screenshots]);

  return (
    <div class="w-screen h-[100vh] bg-transparent relative">
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
              {(media) => {
                const [ref, setRef] = createSignal<HTMLElement | null>(null);
                console.log(media);
                const mediaId = media.path.split("/").pop()?.split(".")[0]!;
                const type = media.type ?? "recording";
                const fileId =
                  type === "recording"
                    ? mediaId
                    : media.path
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
                    if (isRecording) {
                      const res = await commands.copyRenderedVideoToClipboard(
                        mediaId,
                        presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
                      );
                      if (res.status !== "ok") throw new Error(res.error);
                    } else {
                      const res = await commands.copyScreenshotToClipboard(
                        media.path
                      );
                      if (res.status !== "ok") throw new Error(res.error);
                    }
                  },
                }));

                const saveMedia = createMutation(() => ({
                  mutationFn: async () => {
                    const newFileName = isRecording
                      ? "Cap Recording"
                      : media.path.split(".cap/")[1];
                    const fileType = isRecording ? "recording" : "screenshot";

                    const savePathResult = await commands.saveFileDialog(
                      newFileName,
                      fileType
                    );

                    if (
                      savePathResult.status !== "ok" ||
                      !savePathResult.data
                    ) {
                      return false;
                    }

                    const savePath = savePathResult.data;

                    if (isRecording) {
                      const renderedPath = await commands.getRenderedVideo(
                        mediaId,
                        presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
                      );

                      if (renderedPath.status !== "ok" || !renderedPath.data) {
                        throw new Error("Failed to get rendered video path");
                      }

                      const copyResult = await commands.copyFileToPath(
                        renderedPath.data,
                        savePath
                      );
                      if (copyResult.status !== "ok") {
                        throw new Error(
                          `Failed to copy file: ${copyResult.error}`
                        );
                      }
                    } else {
                      const copyResult = await commands.copyFileToPath(
                        media.path,
                        savePath
                      );
                      if (copyResult.status !== "ok") {
                        throw new Error(
                          `Failed to copy file: ${copyResult.error}`
                        );
                      }
                    }

                    return true;
                  },
                }));

                const uploadMedia = createMutation(() => ({
                  mutationFn: async () => {
                    if (isRecording) {
                      const res = await commands.uploadRenderedVideo(
                        mediaId,
                        presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
                      );
                      if (res.status !== "ok") throw new Error(res.error);
                    } else {
                      const res = await commands.uploadScreenshot(media.path);
                      if (res.status !== "ok") throw new Error(res.error);
                    }
                  },
                  onSuccess: () =>
                    startTransition(() => recordingMeta.refetch()),
                }));

                const [metadata] = createResource(async () => {
                  if (isRecording) {
                    const result = await commands.getVideoMetadata(
                      media.path,
                      null
                    );

                    if (result.status !== "ok") {
                      console.error(`Failed to get metadata: ${result.status}`);
                      return;
                    }

                    const [duration, size] = result.data;
                    console.log(
                      `Metadata for ${media.path}: duration=${duration}, size=${size}`
                    );

                    return { duration, size };
                  }
                  return null;
                });

                const [imageExists, setImageExists] = createSignal(true);

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
                        <div
                          class={cx(
                            "w-full h-full absolute inset-0 transition-all",
                            isLoading()
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
                            forceOpen={copyMedia.isPending}
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
                            class="absolute right-3 bottom-3 z-20"
                            tooltipText={
                              recordingMeta.data?.sharing
                                ? "Copy Shareable Link"
                                : uploadMedia.isPending
                                ? "Uploading Cap"
                                : "Create Shareable Link"
                            }
                            forceOpen={uploadMedia.isPending}
                            tooltipPlacement="left"
                            onClick={() => uploadMedia.mutate()}
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
                                isLoading()
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
    forceOpen?: boolean;
  }
) => {
  const [isOpen, setIsOpen] = createSignal(false);

  return (
    <Tooltip
      placement={props.tooltipPlacement as "top" | "bottom" | "left" | "right"}
      openDelay={0}
      closeDelay={0}
      open={props.forceOpen || isOpen()}
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
            "z-index": "1000",
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
