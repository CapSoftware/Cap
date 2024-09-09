import { Button } from "@cap/ui-solid";
import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import {
  RadioGroup as KRadioGroup,
  RadioGroup,
} from "@kobalte/core/radio-group";
import { Select as KSelect } from "@kobalte/core/select";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { createElementBounds } from "@solid-primitives/bounds";
import { trackDeep } from "@solid-primitives/deep";
import { throttle } from "@solid-primitives/scheduled";
import { useSearchParams } from "@solidjs/router";
import { cx } from "cva";
import {
  type Component,
  For,
  type JSX,
  Match,
  Show,
  Suspense,
  Switch,
  batch,
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import { Equal } from "effect";
import { Store } from "@tauri-apps/plugin-store";
import { createWritableMemo } from "@solid-primitives/memo";

import {
  events,
  type AspectRatio,
  type BackgroundSource,
  type CursorType,
  type RenderProgress,
  commands,
  ProjectConfiguration,
} from "../../utils/tauri";
import { EditorContextProvider, useEditorContext } from "./context";
import {
  Dialog,
  DialogContent,
  DropdownItem,
  EditorButton,
  Field,
  Input,
  MenuItem,
  MenuItemList,
  PopperContent,
  Slider,
  Subfield,
  Toggle,
  dropdownContainerClasses,
  topLeftAnimateClasses,
} from "./ui";

export function Editor() {
  const [params] = useSearchParams<{ path: string }>();

  // biome-ignore lint/style/noNonNullAssertion: it's fine i swear
  const videoId = () => params.path?.split("/").at(-1)?.split(".")[0]!;

  return (
    <Show when={videoId()} fallback="No video id available" keyed>
      {(videoId) => (
        <EditorInstanceContextProvider videoId={videoId}>
          <Show
            when={(() => {
              const ctx = useEditorInstanceContext();
              const editorInstance = ctx.editorInstance();

              if (!editorInstance) return;
              return { editorInstance };
            })()}
          >
            {(values) => (
              <EditorContextProvider {...values()}>
                <Inner />
              </EditorContextProvider>
            )}
          </Show>
        </EditorInstanceContextProvider>
      )}
    </Show>
  );
}

function Inner() {
  const {
    project: state,
    videoId,
    editorInstance,
    history,
    currentFrame,
    setDialog,
  } = useEditorContext();

  const duration = () => editorInstance.recordingDuration;

  const [playbackTime, setPlaybackTime] = createSignal<number>(0);

  onMount(() => {
    events.editorStateChanged.listen((e) => {
      renderFrame.clear();
      setPlaybackTime(e.payload.playhead_position / 30);
    });
  });

  const [previewTime, setPreviewTime] = createSignal<number>();

  const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
  const timelineBounds = createElementBounds(timelineRef);

  const renderFrame = throttle((time: number) => {
    events.renderFrameEvent.emit({
      frame_number: Math.floor(time * 30),
      project: state,
    });
  }, 1000 / 60);

  const frameNumberToRender = createMemo(() => {
    const preview = previewTime();
    if (preview !== undefined) return preview;
    return playbackTime();
  });

  createEffect(
    on(frameNumberToRender, (number) => {
      if (playing()) return;
      renderFrame(number);
    })
  );

  createEffect(
    on(
      () => {
        trackDeep(state);
      },
      () => {
        renderFrame(playbackTime());
      }
    )
  );

  const [playing, setPlaying] = createSignal(false);

  const togglePlayback = async () => {
    try {
      if (playing()) {
        await commands.stopPlayback(videoId);
        setPlaying(false);
      } else {
        await commands.startPlayback(videoId, state);
        setPlaying(true);
      }
    } catch (error) {
      console.error("Error toggling playback:", error);
      setPlaying(false);
    }
  };

  createEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        await togglePlayback();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  });

  let canvasRef: HTMLCanvasElement;

  createEffect(() => {
    const frame = currentFrame();
    if (!frame) return;
    const ctx = canvasRef.getContext("2d");
    ctx?.putImageData(frame, 0, 0);
  });

  return (
    <div
      class="p-5 flex flex-col gap-4 w-screen h-screen divide-y bg-gray-50 rounded-lg leading-5"
      data-tauri-drag-region
    >
      <Header />
      <div class="rounded-2xl shadow border flex-1 flex flex-col divide-y bg-white">
        <div class="flex flex-row flex-1 divide-x overflow-y-hidden">
          <div class="flex flex-col divide-y flex-1">
            <div class="flex flex-row justify-between font-medium p-[0.75rem] text-[0.875rem]">
              <div class="flex flex-row items-center gap-[0.5rem]">
                <AspectRatioSelect />
                <EditorButton
                  leftIcon={<IconCapCrop />}
                  onClick={() => {
                    setDialog({
                      open: true,
                      type: "crop",
                      position: {
                        ...(state.background.crop?.position ?? { x: 0, y: 0 }),
                      },
                      size: {
                        ...(state.background.crop?.size ?? {
                          x: editorInstance.recordings.display.width,
                          y: editorInstance.recordings.display.height,
                        }),
                      },
                    });
                  }}
                >
                  Crop
                </EditorButton>
                <PresetsDropdown />
              </div>
              <div class="flex flex-row place-items-center gap-2">
                <EditorButton
                  disabled={!history.canUndo()}
                  leftIcon={<IconCapUndo />}
                  onClick={() => history.undo()}
                >
                  Undo
                </EditorButton>
                <EditorButton
                  disabled={!history.canRedo()}
                  leftIcon={<IconCapRedo />}
                  onClick={() => history.redo()}
                >
                  Redo
                </EditorButton>
              </div>
            </div>
            <div class="bg-gray-100 flex items-center justify-center flex-1 flex-row object-contain p-4">
              <canvas
                class="bg-blue-50 w-full"
                // biome-ignore lint/style/noNonNullAssertion: ref
                ref={canvasRef!}
                id="canvas"
                width={OUTPUT_SIZE.width}
                height={OUTPUT_SIZE.height}
              />
            </div>
            <div class="flex flex-row items-center p-[0.75rem]">
              <div class="flex-1" />
              <div class="flex flex-row items-center justify-center gap-[0.5rem] text-gray-400 text-[0.875rem]">
                <span>{formatTime(playbackTime())}</span>
                <button type="button" disabled>
                  <IconCapFrameFirst class="size-[1.2rem]" />
                </button>
                {!playing() ? (
                  <button
                    type="button"
                    onClick={() =>
                      commands
                        .startPlayback(videoId, state)
                        .then(() => setPlaying(true))
                    }
                  >
                    <IconCapPlayCircle class="size-[1.5rem]" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      commands
                        .stopPlayback(videoId)
                        .then(() => setPlaying(false))
                    }
                  >
                    <IconCapStopCircle class="size-[1.5rem]" />
                  </button>
                )}
                <button type="button" disabled>
                  <IconCapFrameLast class="size-[1rem]" />
                </button>
                <span>{formatTime(duration())}</span>
              </div>
              <div class="flex-1 flex flex-row justify-end">
                <EditorButton<typeof KToggleButton>
                  disabled
                  as={KToggleButton}
                  variant="danger"
                  leftIcon={<IconCapScissors />}
                >
                  Split
                </EditorButton>
              </div>
            </div>
          </div>
          <SettingsSidebar />
        </div>
        <div class="px-[0.75rem] py-[2rem] relative">
          <Show when={previewTime()}>
            {(time) => (
              <div
                class="w-px bg-black-transparent-20 absolute left-5 top-4 bottom-0 z-10 pointer-events-none"
                style={{
                  transform: `translateX(${
                    (time() / duration()) * (timelineBounds.width ?? 0)
                  }px)`,
                }}
              >
                <div class="size-2 bg-black-transparent-20 rounded-full -mt-2 -ml-[calc(0.25rem-0.5px)]" />
              </div>
            )}
          </Show>
          <div
            class="w-px bg-red-300 absolute left-5 top-4 bottom-0 z-10"
            style={{
              transform: `translateX(${
                (playbackTime() / duration()) * (timelineBounds.width ?? 0)
              }px)`,
            }}
          >
            <div class="size-2 bg-red-300 rounded-full -mt-2 -ml-[calc(0.25rem-0.5px)]" />
          </div>
          <div class="relative h-[3rem] border border-white ring-1 ring-blue-300 flex flex-row rounded-xl overflow-hidden">
            <div class="bg-blue-300 w-[0.5rem]" />
            <div
              ref={setTimelineRef}
              class="bg-blue-50 relative w-full h-full flex flex-row items-end justify-end px-[0.5rem] py-[0.25rem]"
              onMouseDown={(e) => {
                const { left, width } = e.currentTarget.getBoundingClientRect();
                commands.setPlayheadPosition(
                  videoId,
                  Math.round(30 * duration() * ((e.clientX - left) / width))
                );
              }}
              onMouseMove={(e) => {
                const { left, width } = e.currentTarget.getBoundingClientRect();
                setPreviewTime(
                  Math.max(duration() * ((e.clientX - left) / width), 0)
                );
              }}
              onMouseLeave={() => {
                setPreviewTime(undefined);
              }}
            >
              <span class="text-black-transparent-60 text-[0.625rem]">
                0:00
              </span>
              <span class="text-black-transparent-60 text-[0.625rem] ml-auto">
                {formatTime(duration())}
              </span>
            </div>
            <div class="bg-blue-300 w-[0.5rem]" />
          </div>
        </div>
      </div>
      <Dialogs />
    </div>
  );
}

function formatTime(secs: number) {
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function Header() {
  const [params] = useSearchParams<{ path: string }>();

  return (
    <header
      class="flex flex-row justify-between items-center"
      data-tauri-drag-region
    >
      <div class="flex flex-row items-center gap-[0.5rem] text-[0.875rem]">
        <div class="flex flex-row items-center gap-[0.375rem]">
          <div class="size-[1.5rem] rounded-[0.25rem] bg-gray-500 bg-black" />
          <span>My Workspace</span>
        </div>
        <span class="text-gray-400">/</span>
        <div class="flex flex-row items-center gap-[0.375rem]">
          <span>Cap Title</span>
        </div>
      </div>
      <div
        class="flex flex-row gap-4 font-medium items-center"
        data-tauri-drag-region
      >
        <ShareButton />
        <ExportButton />
      </div>
    </header>
  );
}

import {
  createEventListener,
  createEventListenerMap,
} from "@solid-primitives/event-listener";
import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  EditorInstanceContextProvider,
  OUTPUT_SIZE,
  useEditorInstanceContext,
} from "./editorInstanceContext";
import {
  ASPECT_RATIOS,
  DEFAULT_GRADIENT_FROM,
  DEFAULT_GRADIENT_TO,
} from "./projectConfig";
import { createMutation } from "@tanstack/solid-query";

function ExportButton() {
  const { videoId, project } = useEditorContext();

  const [state, setState] = createStore<
    | { open: false; type: "idle" }
    | ({ open: boolean } & (
        | { type: "inProgress"; progress: number; totalFrames: number }
        | { type: "finished"; path: string }
      ))
  >({ open: false, type: "idle" });

  return (
    <>
      <Button
        variant="primary"
        size="md"
        onClick={() => {
          save({
            filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
          }).then((p) => {
            if (!p) return;

            setState(
              reconcile({
                open: true,
                type: "inProgress",
                progress: 0,
                totalFrames: 0,
              })
            );

            const progress = new Channel<RenderProgress>();
            progress.onmessage = (p) => {
              if (p.type === "FrameRendered" && state.type === "inProgress")
                setState({ progress: p.current_frame });
              if (
                p.type === "EstimatedTotalFrames" &&
                state.type === "inProgress"
              ) {
                console.log("Total frames: ", p.total_frames);
                setState({ totalFrames: p.total_frames });
              }
            };

            return commands
              .renderToFile(p, videoId, project, progress)
              .then(() => {
                setState({ ...state, type: "finished", path: p });
              });
          });
        }}
      >
        Export
      </Button>
      <Dialog.Root
        open={state.open}
        onOpenChange={(o) => {
          if (!o) setState(reconcile({ ...state, open: false }));
        }}
      >
        <DialogContent
          title="Export Recording"
          confirm={
            <Show when={state.type === "finished" && state}>
              {(state) => (
                <Button
                  onClick={() => {
                    commands.openInFinder(state().path);
                  }}
                >
                  Open in Finder
                </Button>
              )}
            </Show>
          }
        >
          <Switch>
            <Match when={state.type === "finished"}>Finished exporting</Match>
            <Match when={state.type === "inProgress" && state}>
              {(state) => (
                <>
                  <div class="w-full bg-gray-200 rounded-full h-2.5">
                    <div
                      class="bg-blue-300 h-2.5 rounded-full"
                      style={{
                        width: `${Math.min(
                          (state().progress / (state().totalFrames || 1)) * 100,
                          100
                        )}%`,
                      }}
                    />
                  </div>
                </>
              )}
            </Match>
          </Switch>
        </DialogContent>
      </Dialog.Root>
    </>
  );
}

function ShareButton() {
  return (
    <button
      class="rounded-full h-[2rem] px-[1rem] flex flex-row items-center gap-[0.375rem] bg-gray-200 hover:bg-gray-300 transition-colors duration-100"
      type="button"
    >
      <span class="text-[0.875rem] text-gray-500">
        cap.link/z2ha3dv61q5hrde
      </span>
    </button>
  );
}

const BACKGROUND_SOURCES = {
  wallpaper: "Wallpaper",
  image: "Image",
  color: "Color",
  gradient: "Gradient",
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_SOURCES_LIST = [
  "wallpaper",
  "image",
  "color",
  "gradient",
] satisfies Array<BackgroundSource["type"]>;

function SettingsSidebar() {
  const { selectedTab, setSelectedTab, project, setProject } =
    useEditorContext();

  return (
    <KTabs
      value={selectedTab()}
      class="flex flex-col shrink-0 overflow-x-hidden overflow-y-hidden w-[25.5rem]"
    >
      <KTabs.List class="h-[3.5rem] flex flex-row divide-x divide-gray-200 text-black/50 text-lg relative z-40 overflow-x-auto border-b border-gray-200">
        <For
          each={[
            { id: "background" as const, icon: IconCapImage },
            { id: "camera" as const, icon: IconCapCamera },
            {
              id: "transcript" as const,
              icon: IconCapMessageBubble,
            },
            { id: "audio" as const, icon: IconCapAudioOn },
            { id: "cursor" as const, icon: IconCapCursor },
            { id: "hotkeys" as const, icon: IconCapHotkeys },
          ]}
        >
          {(item) => (
            <KTabs.Trigger
              value={item.id}
              class="flex-1 text-gray-400 ui-selected:text-gray-500 z-10"
              onClick={() => setSelectedTab(item.id)}
            >
              <Dynamic class="mx-auto" component={item.icon} />
            </KTabs.Trigger>
          )}
        </For>
        <KTabs.Indicator class="absolute inset-0">
          <div class="bg-gray-100 w-full h-full" />
        </KTabs.Indicator>
      </KTabs.List>
      <div class="p-[0.75rem] overflow-y-auto text-[0.875rem]">
        <KTabs.Content value="background" class="flex flex-col gap-[1.5rem]">
          <Field name="Background" icon={<IconCapImage />}>
            <KTabs
              class="space-y-3"
              value={project.background.source.type}
              onChange={(v) => {
                const tab = v as BackgroundSource["type"];

                switch (tab) {
                  case "wallpaper": {
                    setProject("background", "source", {
                      type: "wallpaper",
                      id: 0,
                    });
                    return;
                  }
                  case "image": {
                    setProject("background", "source", {
                      type: "image",
                      path: null,
                    });
                    return;
                  }
                  case "color": {
                    setProject("background", "source", {
                      type: "color",
                      value: DEFAULT_GRADIENT_FROM,
                    });
                    return;
                  }
                  case "gradient": {
                    setProject("background", "source", {
                      type: "gradient",
                      from: DEFAULT_GRADIENT_FROM,
                      to: DEFAULT_GRADIENT_TO,
                    });
                    return;
                  }
                }
              }}
            >
              <KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
                <div class="absolute inset-0 flex flex-row items-center justify-evenly">
                  <For
                    each={Array.from(
                      { length: BACKGROUND_SOURCES_LIST.length - 1 },
                      (_, i) => i
                    )}
                  >
                    {(i) => (
                      <div
                        class={cx(
                          "w-px h-[0.75rem] rounded-full transition-colors",
                          BACKGROUND_SOURCES_LIST.indexOf(
                            project.background.source.type
                          ) === i ||
                            BACKGROUND_SOURCES_LIST.indexOf(
                              project.background.source.type
                            ) ===
                              i + 1
                            ? "bg-gray-50"
                            : "bg-gray-200"
                        )}
                      />
                    )}
                  </For>
                </div>
                <For each={BACKGROUND_SOURCES_LIST}>
                  {(item, i) => (
                    <KTabs.Trigger
                      class="flex-1 text-gray-400 py-1 z-10 ui-selected:text-gray-500 peer outline-none transition-colors duration-100"
                      value={item}
                      disabled={item === "wallpaper" || item === "image"}
                    >
                      {BACKGROUND_SOURCES[item]}
                    </KTabs.Trigger>
                  )}
                </For>
                <KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden">
                  <div class="bg-gray-100 flex-1" />
                </KTabs.Indicator>
              </KTabs.List>
              <KTabs.Content value="wallpaper">
                <KRadioGroup
                  value={
                    project.background.source.type === "wallpaper"
                      ? project.background.source.id.toString()
                      : undefined
                  }
                  onChange={(v) =>
                    setProject("background", "source", {
                      type: "wallpaper",
                      id: Number(v),
                    })
                  }
                  class="grid grid-cols-7 grid-rows-2 gap-2 h-[6.8rem]"
                >
                  <For each={[...Array(14).keys()]}>
                    {(_, i) => (
                      <KRadioGroup.Item
                        value={i().toString()}
                        class="col-span-1 row-span-1"
                      >
                        <KRadioGroup.ItemInput class="peer" />
                        <KRadioGroup.ItemControl class="cursor-pointer bg-gray-100 rounded-lg w-full h-full border border-gray-200 ui-checked:border-blue-300 peer-focus-visible:border-2 peer-focus-visible:border-blue-300" />
                      </KRadioGroup.Item>
                    )}
                  </For>
                </KRadioGroup>
              </KTabs.Content>
              <KTabs.Content value="image">
                <button
                  type="button"
                  class="p-[0.75rem] bg-gray-100 w-full rounded-[0.5rem] border flex flex-col items-center justify-center gap-[0.5rem] text-gray-400"
                >
                  <IconCapImage class="size-6" />
                  <span>Click to select or drag and drop image</span>
                </button>
              </KTabs.Content>
              <KTabs.Content value="color">
                <Show
                  when={
                    project.background.source.type === "color" &&
                    project.background.source
                  }
                >
                  {(source) => (
                    <RgbInput
                      value={source().value}
                      onChange={(value) =>
                        setProject("background", "source", {
                          type: "color",
                          value,
                        })
                      }
                    />
                  )}
                </Show>
              </KTabs.Content>
              <KTabs.Content
                value="gradient"
                class="flex flex-row items-center gap-[1.5rem]"
              >
                <Show
                  when={
                    project.background.source.type === "gradient" &&
                    project.background.source
                  }
                >
                  {(source) => (
                    <>
                      <RgbInput
                        value={source().from}
                        onChange={(from) =>
                          setProject("background", "source", {
                            type: "gradient",
                            from,
                            to: source().to,
                          })
                        }
                      />
                      <RgbInput
                        value={source().to}
                        onChange={(to) =>
                          setProject("background", "source", {
                            type: "gradient",
                            from: source().from,
                            to,
                          })
                        }
                      />
                    </>
                  )}
                </Show>
              </KTabs.Content>
            </KTabs>
          </Field>

          <Field name="Background Blur" icon={<IconCapBlur />}>
            <Slider
              disabled
              value={[project.background.blur]}
              onChange={(v) => setProject("background", "blur", v[0])}
              minValue={0}
              maxValue={100}
            />
          </Field>
          <Field name="Padding" icon={<IconCapPadding />}>
            <Slider
              value={[project.background.padding]}
              onChange={(v) => setProject("background", "padding", v[0])}
              minValue={0}
              maxValue={40}
              step={0.1}
            />
          </Field>
          <Field name="Rounded Corners" icon={<IconCapCorners />}>
            <Slider
              value={[project.background.rounding]}
              onChange={(v) => setProject("background", "rounding", v[0])}
              minValue={0}
              maxValue={100}
              step={0.1}
            />
          </Field>
          <Field name="Inset" icon={<IconCapInset />}>
            <Slider
              disabled
              value={[project.background.inset]}
              onChange={(v) => setProject("background", "inset", v[0])}
              minValue={0}
              maxValue={100}
            />
          </Field>
        </KTabs.Content>
        <KTabs.Content value="camera" class="flex flex-col gap-[1.5rem]">
          <Field name="Camera" icon={<IconCapCamera />}>
            <div class="flex flex-col gap-[0.75rem]">
              <Subfield name="Hide Camera">
                <Toggle
                  checked={project.camera.hide}
                  onChange={(hide) => setProject("camera", "hide", hide)}
                />
              </Subfield>
              <Subfield name="Mirror Camera">
                <Toggle
                  checked={project.camera.mirror}
                  onChange={(mirror) => setProject("camera", "mirror", mirror)}
                />
              </Subfield>
              <div>
                <Subfield name="Camera Position" class="mt-[0.75rem]" />
                <KRadioGroup
                  value={`${project.camera.position.x}:${project.camera.position.y}`}
                  onChange={(v) => {
                    const [x, y] = v.split(":");
                    setProject("camera", "position", { x, y } as any);
                  }}
                  class="mt-[0.75rem] rounded-[0.5rem] border border-gray-200 bg-gray-100 w-full h-[7.5rem] relative"
                >
                  <For
                    each={[
                      { x: "left", y: "top" } as const,
                      { x: "center", y: "top" } as const,
                      { x: "right", y: "top" } as const,
                      { x: "left", y: "bottom" } as const,
                      { x: "center", y: "bottom" } as const,
                      { x: "right", y: "bottom" } as const,
                    ]}
                  >
                    {(item) => (
                      <RadioGroup.Item value={`${item.x}:${item.y}`}>
                        <RadioGroup.ItemInput class="peer" />
                        <RadioGroup.ItemControl
                          class={cx(
                            "cursor-pointer size-[1.25rem] shink-0 rounded-[0.375rem] bg-gray-300 absolute flex justify-center items-center ui-checked:bg-blue-300 focus-visible:outline peer-focus-visible:outline outline-2 outline-offset-2 outline-blue-300 transition-colors duration-100",
                            item.x === "left"
                              ? "left-2"
                              : item.x === "right"
                              ? "right-2"
                              : "left-1/2 transform -translate-x-1/2",
                            item.y === "top" ? "top-2" : "bottom-2"
                          )}
                          onClick={() => setProject("camera", "position", item)}
                        >
                          <div class="size-[0.5rem] shrink-0 bg-gray-50 rounded-full" />
                        </RadioGroup.ItemControl>
                      </RadioGroup.Item>
                    )}
                  </For>
                </KRadioGroup>
              </div>
            </div>
          </Field>
          <Field name="Rounded Corners" icon={<IconCapCorners />}>
            <Slider
              value={[project.camera.rounding]}
              onChange={(v) => setProject("camera", "rounding", v[0])}
              minValue={0}
              maxValue={100}
              step={0.1}
            />
          </Field>
          <Field name="Shadow" icon={<IconCapShadow />}>
            <Slider
              value={[project.camera.shadow]}
              onChange={(v) => setProject("camera", "shadow", v[0])}
              minValue={0}
              maxValue={100}
            />
          </Field>
        </KTabs.Content>
        <KTabs.Content value="transcript" class="flex flex-col gap-6">
          <Field name="Transcript" icon={<IconCapMessageBubble />}>
            <div class="text-wrap bg-gray-50 border text-gray-400 p-1 rounded-md">
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed ac
              purus sit amet nunc ultrices ultricies. Nullam nec scelerisque
              nunc. Nullam nec scelerisque nunc.
            </div>
            <button
              type="button"
              class="w-full bg-gray-400/20 hover:bg-gray-400/30 transition-colors duration-100 rounded-full py-1.5"
            >
              Edit
            </button>
          </Field>
        </KTabs.Content>
        <KTabs.Content value="audio" class="flex flex-col gap-6">
          <Field name="Audio" icon={<IconCapAudioOn />}>
            <div class="flex flex-col gap-3 ">
              <Subfield name="Mute Audio">
                <Toggle />
              </Subfield>
              <Subfield name="Improve Mic Quality">
                <Toggle disabled />
              </Subfield>
            </div>
          </Field>
        </KTabs.Content>
        <KTabs.Content value="cursor" class="flex flex-col gap-6">
          <Field name="Cursor" icon={<IconCapCursor />}>
            <Subfield name="Hide cursor when not moving">
              <Toggle disabled />
            </Subfield>
          </Field>
          <Field name="Size" icon={<IconCapEnlarge />}>
            <Slider
              disabled
              value={[project.cursor.size]}
              onChange={(v) => setProject("cursor", "size", v[0])}
              minValue={0}
              maxValue={100}
            />
          </Field>
          <Field name="Type" icon={<IconCapCursor />}>
            <ul class="flex flex-row gap-2 text-gray-400">
              <For
                each={
                  [
                    { type: "pointer", icon: IconCapCursor },
                    { type: "circle", icon: IconCapCircle },
                  ] satisfies Array<{
                    icon: Component;
                    type: CursorType;
                  }>
                }
              >
                {(item) => (
                  <li>
                    <button
                      disabled
                      type="button"
                      onClick={() => setProject("cursor", "type", item.type)}
                      data-selected={project.cursor.type === item.type}
                      class="border border-black-transparent-5 bg-gray-100 rounded-lg p-[0.625rem] text-gray-400 data-[selected='true']:text-gray-500 disabled:text-gray-300 focus-visible:outline-blue-300 focus-visible:outline outline-1 outline-offset-1"
                    >
                      <Dynamic
                        component={item.icon}
                        class="size-[1.75rem] mx-auto"
                      />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Field>
        </KTabs.Content>
        <KTabs.Content value="hotkeys">
          <Field name="Hotkeys" icon={<IconCapHotkeys />}>
            <Subfield name="Show hotkeys">
              <Toggle disabled />
            </Subfield>
          </Field>
        </KTabs.Content>
      </div>
    </KTabs>
  );
}

function AspectRatioSelect() {
  const { project, setProject } = useEditorContext();

  return (
    <KSelect<AspectRatio | "auto">
      disabled
      value={project.aspectRatio ?? "auto"}
      onChange={(v) => {
        if (v === null) return;
        setProject("aspectRatio", v === "auto" ? null : v);
      }}
      defaultValue="auto"
      options={
        ["auto", "wide", "vertical", "square", "classic", "tall"] as const
      }
      multiple={false}
      itemComponent={(props) => {
        const item = () =>
          ASPECT_RATIOS[
            props.item.rawValue === "auto" ? "wide" : props.item.rawValue
          ];

        return (
          <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
            <KSelect.ItemLabel class="flex-1">
              {props.item.rawValue === "auto"
                ? "Auto"
                : ASPECT_RATIOS[props.item.rawValue].name}
              <Show when={item()}>
                {(item) => (
                  <span class="text-gray-400">
                    {"⋅"}
                    {item().ratio[0]}:{item().ratio[1]}
                  </span>
                )}
              </Show>
            </KSelect.ItemLabel>
            <KSelect.ItemIndicator class="ml-auto">
              <IconCapCircleCheck />
            </KSelect.ItemIndicator>
          </MenuItem>
        );
      }}
      placement="top-start"
    >
      <EditorButton<typeof KSelect.Trigger>
        as={KSelect.Trigger}
        leftIcon={<IconCapLayout />}
        rightIcon={
          <KSelect.Icon>
            <IconCapChevronDown />
          </KSelect.Icon>
        }
      >
        <KSelect.Value<AspectRatio | "auto">>
          {(state) => {
            const text = () => {
              const option = state.selectedOption();
              return option === "auto" ? "Auto" : ASPECT_RATIOS[option].name;
            };
            return <>{text()}</>;
          }}
        </KSelect.Value>
      </EditorButton>
      <KSelect.Portal>
        <PopperContent<typeof KSelect.Content>
          as={KSelect.Content}
          class={topLeftAnimateClasses}
        >
          <MenuItemList<typeof KSelect.Listbox>
            as={KSelect.Listbox}
            class="w-[12.5rem]"
          />
        </PopperContent>
      </KSelect.Portal>
    </KSelect>
  );
}

function PresetsDropdown() {
  const { setDialog, presets, setProject } = useEditorContext();

  return (
    <KDropdownMenu gutter={8}>
      <EditorButton<typeof KDropdownMenu.Trigger>
        as={KDropdownMenu.Trigger}
        leftIcon={<IconCapPresets />}
      >
        Presets
      </EditorButton>
      <KDropdownMenu.Portal>
        <Suspense>
          <PopperContent<typeof KDropdownMenu.Content>
            as={KDropdownMenu.Content}
            class={cx("w-72 max-h-56", topLeftAnimateClasses)}
          >
            <MenuItemList<typeof KDropdownMenu.Group>
              as={KDropdownMenu.Group}
              class="flex-1 overflow-y-auto scrollbar-none"
            >
              <For
                each={presets.query()?.presets ?? []}
                fallback={
                  <div class="w-full text-sm text-gray-400 text-center py-1">
                    No Presets
                  </div>
                }
              >
                {(preset, i) => {
                  const [showSettings, setShowSettings] = createSignal(false);

                  console.log(presets.query());

                  return (
                    <KDropdownMenu.Sub gutter={16}>
                      <MenuItem<typeof KDropdownMenu.SubTrigger>
                        as={KDropdownMenu.SubTrigger}
                        onFocusIn={() => setShowSettings(false)}
                        onClick={() => setShowSettings(false)}
                      >
                        <span class="mr-auto">{preset.name}</span>
                        <Show when={presets.query()?.default === i()}>
                          <span class="px-[0.375rem] h-[1.25rem] rounded-full bg-gray-100 text-gray-400 text-[0.75rem]">
                            Default
                          </span>
                        </Show>
                        <button
                          type="button"
                          class="text-gray-400 hover:text-black"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowSettings((s) => !s);
                          }}
                          onPointerUp={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                        >
                          <IconCapSettings />
                        </button>
                      </MenuItem>
                      <KDropdownMenu.Portal>
                        {showSettings() && (
                          <>
                            BRUH
                            <MenuItemList<typeof KDropdownMenu.SubContent>
                              as={KDropdownMenu.SubContent}
                              class={cx(
                                "animate-in fade-in slide-in-from-left-1 w-44",
                                dropdownContainerClasses
                              )}
                            >
                              <DropdownItem
                                onSelect={() => setProject(preset.config)}
                              >
                                Apply
                              </DropdownItem>
                              <DropdownItem
                                onSelect={() => presets.setDefault(i())}
                              >
                                Set as default
                              </DropdownItem>
                              <DropdownItem
                                onSelect={() =>
                                  setDialog({
                                    type: "renamePreset",
                                    presetIndex: i(),
                                    open: true,
                                  })
                                }
                              >
                                Rename
                              </DropdownItem>
                              <DropdownItem
                                onClick={() =>
                                  setDialog({
                                    type: "deletePreset",
                                    presetIndex: i(),
                                    open: true,
                                  })
                                }
                              >
                                Delete
                              </DropdownItem>
                            </MenuItemList>
                          </>
                        )}
                      </KDropdownMenu.Portal>
                    </KDropdownMenu.Sub>
                  );
                }}
              </For>
            </MenuItemList>
            <MenuItemList<typeof KDropdownMenu.Group>
              as={KDropdownMenu.Group}
              class="border-t shrink-0"
            >
              <DropdownItem
                onSelect={() => setDialog({ type: "createPreset", open: true })}
              >
                <span>Create new preset</span>
                <IconCapCirclePlus class="ml-auto" />
              </DropdownItem>
            </MenuItemList>
          </PopperContent>
        </Suspense>
      </KDropdownMenu.Portal>
    </KDropdownMenu>
  );
}

function Dialogs() {
  const { dialog, setDialog, presets, project } = useEditorContext();

  return (
    <Dialog.Root
      size={dialog().type === "crop" ? "lg" : "sm"}
      open={dialog().open}
      onOpenChange={(o) => {
        if (!o) setDialog((d) => ({ ...d, open: false }));
      }}
    >
      <Show
        when={(() => {
          const d = dialog();
          if ("type" in d) return d;
        })()}
      >
        {(dialog) => (
          <Switch>
            <Match when={dialog().type === "createPreset"}>
              {(_) => {
                const [form, setForm] = createStore({
                  name: "",
                  default: false,
                });

                const createPreset = createMutation(() => ({
                  mutationFn: async () =>
                    presets.createPreset({ ...form, config: project }),
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Create Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        disabled={createPreset.isPending}
                        onClick={() => createPreset.mutate()}
                      >
                        Create
                      </Dialog.ConfirmButton>
                    }
                  >
                    <Subfield name="Name" required />
                    <Input
                      class="mt-[0.25rem]"
                      value={form.name}
                      onInput={(e) => setForm("name", e.currentTarget.value)}
                    />
                    <Subfield name="Set as default" class="mt-[0.75rem]">
                      <Toggle
                        checked={form.default}
                        onChange={(checked) => setForm("default", checked)}
                      />
                    </Subfield>
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "renamePreset") return d;
              })()}
            >
              {(dialog) => {
                const [name, setName] = createSignal(
                  presets.query()?.presets[dialog().presetIndex].name!
                );

                const renamePreset = createMutation(() => ({
                  mutationFn: async () =>
                    presets.renamePreset(dialog().presetIndex, name()),
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Rename Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        onClick={() => renamePreset.mutate()}
                      >
                        Rename
                      </Dialog.ConfirmButton>
                    }
                  >
                    <Subfield name="Name" required />
                    <Input
                      value={name()}
                      onInput={(e) => setName(e.currentTarget.value)}
                    />
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "deletePreset") return d;
              })()}
            >
              {(dialog) => {
                const deletePreset = createMutation(() => ({
                  mutationFn: async () =>
                    presets.deletePreset(dialog().presetIndex),
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Delete Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        variant="destructive"
                        onClick={() => deletePreset.mutate()}
                      >
                        Delete
                      </Dialog.ConfirmButton>
                    }
                  >
                    <p class="text-gray-400">
                      Lorem ipsum dolor sit amet, consectetur adipiscing elit
                      sed do eiusmod tempor incididunt ut labore et dolore magna
                      aliqua.
                    </p>
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "crop") return d;
              })()}
            >
              {(dialog) => {
                const { setProject: setState, editorInstance } =
                  useEditorContext();
                const [params] = useSearchParams<{ path: string }>();
                const [crop, setCrop] = createStore({
                  position: dialog().position,
                  size: dialog().size,
                });

                const display = editorInstance.recordings.display;

                const styles = createMemo(() => {
                  return {
                    left: `${(crop.position.x / display.width) * 100}%`,
                    top: `${(crop.position.y / display.height) * 100}%`,
                    right: `calc(${
                      ((display.width - crop.size.x - crop.position.x) /
                        display.width) *
                      100
                    }%)`,
                    bottom: `calc(${
                      ((display.height - crop.size.y - crop.position.y) /
                        display.height) *
                      100
                    }%)`,
                  };
                });

                let cropAreaRef: HTMLDivElement;
                let cropTargetRef: HTMLDivElement;

                return (
                  <>
                    <Dialog.Header>
                      <div class="flex flex-row space-x-[0.75rem]">
                        {/* <AspectRatioSelect />*/}
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-400">
                          <span>Size</span>
                          <div class="w-[3.25rem]">
                            <Input value={crop.size.x} disabled />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input value={crop.size.y} disabled />
                          </div>
                        </div>
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-400">
                          <span>Position</span>
                          <div class="w-[3.25rem]">
                            <Input value={crop.position.x} disabled />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="w-[3.25rem]"
                              value={crop.position.y}
                              disabled
                            />
                          </div>
                        </div>
                      </div>
                      <EditorButton
                        leftIcon={<IconCapCircleX />}
                        class="ml-auto"
                        onClick={() =>
                          setCrop({
                            position: { x: 0, y: 0 },
                            size: {
                              x: editorInstance.recordings.display.width,
                              y: editorInstance.recordings.display.height,
                            },
                          })
                        }
                      >
                        Reset
                      </EditorButton>
                    </Dialog.Header>
                    <Dialog.Content>
                      <div
                        class="relative"
                        // biome-ignore lint/style/noNonNullAssertion: ref
                        ref={cropAreaRef!}
                      >
                        <div class="divide-black-transparent-10 overflow-hidden rounded-lg">
                          <img
                            class="shadow pointer-events-none"
                            alt="screenshot"
                            src={convertFileSrc(
                              `${params.path}/screenshots/display.jpg`
                            )}
                          />
                        </div>
                        <div
                          class="bg-white-transparent-20 absolute cursor-move"
                          // biome-ignore lint/style/noNonNullAssertion: ref
                          ref={cropTargetRef!}
                          style={styles()}
                          onMouseDown={(downEvent) => {
                            const original = {
                              position: { ...crop.position },
                              size: { ...crop.size },
                            };

                            createRoot((dispose) => {
                              createEventListenerMap(window, {
                                mouseup: () => dispose(),
                                mousemove: (moveEvent) => {
                                  const diff = {
                                    x:
                                      ((moveEvent.clientX - downEvent.clientX) /
                                        cropAreaRef.clientWidth) *
                                      display.width,
                                    y:
                                      ((moveEvent.clientY - downEvent.clientY) /
                                        cropAreaRef.clientHeight) *
                                      display.height,
                                  };

                                  batch(() => {
                                    if (original.position.x + diff.x < 0)
                                      setCrop("position", "x", 0);
                                    else if (
                                      original.position.x + diff.x >
                                      display.width - crop.size.x
                                    )
                                      setCrop(
                                        "position",
                                        "x",
                                        display.width - crop.size.x
                                      );
                                    else
                                      setCrop(
                                        "position",
                                        "x",
                                        original.position.x + diff.x
                                      );

                                    if (original.position.y + diff.y < 0)
                                      setCrop("position", "y", 0);
                                    else if (
                                      original.position.y + diff.y >
                                      display.height - crop.size.y
                                    )
                                      setCrop(
                                        "position",
                                        "y",
                                        display.height - crop.size.y
                                      );
                                    else
                                      setCrop(
                                        "position",
                                        "y",
                                        original.position.y + diff.y
                                      );
                                  });
                                },
                              });
                            });
                          }}
                        >
                          <For
                            each={Array.from({ length: 4 }, (_, i) => ({
                              x: i < 2 ? ("l" as const) : ("r" as const),
                              y: i % 2 === 0 ? ("t" as const) : ("b" as const),
                            }))}
                          >
                            {(pos) => {
                              const behaviours = {
                                x:
                                  pos.x === "l"
                                    ? ("both" as const)
                                    : ("resize" as const),
                                y:
                                  pos.y === "t"
                                    ? ("both" as const)
                                    : ("resize" as const),
                              };

                              return (
                                <button
                                  type="button"
                                  class="absolute"
                                  style={{
                                    ...(pos.x === "l"
                                      ? { left: "0px" }
                                      : { right: "0px" }),
                                    ...(pos.y === "t"
                                      ? { top: "0px" }
                                      : { bottom: "0px" }),
                                  }}
                                  onMouseDown={(downEvent) => {
                                    downEvent.stopPropagation();

                                    const original = {
                                      position: { ...crop.position },
                                      size: { ...crop.size },
                                    };

                                    const MIN_SIZE = 100;

                                    createRoot((dispose) => {
                                      createEventListenerMap(window, {
                                        mouseup: () => dispose(),
                                        mousemove: (moveEvent) => {
                                          batch(() => {
                                            const diff = {
                                              x:
                                                ((moveEvent.clientX -
                                                  downEvent.clientX) /
                                                  cropAreaRef.clientWidth) *
                                                display.width,
                                              y:
                                                ((moveEvent.clientY -
                                                  downEvent.clientY) /
                                                  cropAreaRef.clientHeight) *
                                                display.height,
                                            };

                                            if (behaviours.x === "resize") {
                                              setCrop(
                                                "size",
                                                "x",
                                                clamp(
                                                  original.size.x + diff.x,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.width -
                                                    crop.position.x
                                                )
                                              );
                                            } else {
                                              setCrop(
                                                "position",
                                                "x",
                                                clamp(
                                                  original.position.x + diff.x,
                                                  0,
                                                  editorInstance.recordings
                                                    .display.width - MIN_SIZE
                                                )
                                              );
                                              setCrop(
                                                "size",
                                                "x",
                                                clamp(
                                                  original.size.x - diff.x,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.width
                                                )
                                              );
                                            }

                                            if (behaviours.y === "resize") {
                                              setCrop(
                                                "size",
                                                "y",
                                                clamp(
                                                  original.size.y + diff.y,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.height -
                                                    crop.position.y
                                                )
                                              );
                                            } else {
                                              setCrop(
                                                "position",
                                                "y",
                                                clamp(
                                                  original.position.y + diff.y,
                                                  0,
                                                  editorInstance.recordings
                                                    .display.height - MIN_SIZE
                                                )
                                              );
                                              setCrop(
                                                "size",
                                                "y",
                                                clamp(
                                                  original.size.y - diff.y,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.height
                                                )
                                              );
                                            }
                                          });
                                        },
                                      });
                                    });
                                  }}
                                >
                                  <div class="size-[1rem] bg-gray-500 border border-gray-50 rounded-full absolute -top-[0.5rem] -left-[0.5rem]" />
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    </Dialog.Content>
                    <Dialog.Footer>
                      <Button
                        onClick={() => {
                          setState("background", "crop", crop);
                          setDialog((d) => ({ ...d, open: false }));
                        }}
                      >
                        Save
                      </Button>
                    </Dialog.Footer>
                  </>
                );
              }}
            </Match>
          </Switch>
        )}
      </Show>
    </Dialog.Root>
  );
}

function RgbInput(props: {
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}) {
  const [text, setText] = createWritableMemo(() => rgbToHex(props.value));
  let prevHex = rgbToHex(props.value);

  let colorInput: HTMLInputElement;

  return (
    <div class="flex flex-row items-center gap-[0.75rem] relative">
      <button
        type="button"
        class="size-[3rem] rounded-[0.5rem]"
        style={{
          "background-color": rgbToHex(props.value),
        }}
        onClick={() => colorInput.click()}
      />
      <input
        ref={colorInput!}
        type="color"
        class="absolute left-0 bottom-0 w-[3rem] opacity-0"
        onChange={(e) => {
          const value = hexToRgb(e.target.value);
          if (value) props.onChange(value);
        }}
      />
      <input
        class="w-[5rem] p-[0.375rem] border text-gray-400 rounded-[0.5rem]"
        value={text()}
        onFocus={() => {
          prevHex = rgbToHex(props.value);
        }}
        onInput={(e) => {
          setText(e.currentTarget.value);

          const value = hexToRgb(e.target.value);
          if (value) props.onChange(value);
        }}
        onBlur={(e) => {
          const value = hexToRgb(e.target.value);
          if (value) props.onChange(value);
          else {
            setText(prevHex);
            props.onChange(hexToRgb(text())!);
          }
        }}
      />
    </div>
  );
}

function rgbToHex(rgb: [number, number, number]) {
  return `#${rgb
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return null;
  return match.slice(1).map((c) => Number.parseInt(c, 16)) as any;
}

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}
