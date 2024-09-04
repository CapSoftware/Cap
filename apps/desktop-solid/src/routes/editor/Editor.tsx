import { Button } from "@cap/ui-solid";
import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { Select as KSelect } from "@kobalte/core/select";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import {
  RadioGroup as KRadioGroup,
  RadioGroup,
} from "@kobalte/core/radio-group";
import { cx } from "cva";
import {
  type Component,
  For,
  type JSX,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { throttle } from "@solid-primitives/scheduled";
import { trackDeep } from "@solid-primitives/deep";
import { useSearchParams } from "@solidjs/router";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { createElementBounds } from "@solid-primitives/bounds";

import {
  ASPECT_RATIOS,
  DEFAULT_FROM,
  DEFAULT_TO,
  EditorContextProvider,
  useEditorContext,
} from "./context";
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
import {
  commands,
  events,
  type RenderProgress,
  type AspectRatio,
  type BackgroundSource,
  type CursorType,
} from "../../utils/tauri";

export function Editor() {
  return (
    <EditorContextProvider>
      <Inner />
    </EditorContextProvider>
  );
}

const OUTPUT_SIZE = {
  width: 1920,
  height: 1080,
};

function Inner() {
  const duration = 10;

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

  const { canvasRef, setCanvasRef, state, videoId } = useEditorContext();

  onMount(() => {
    commands.createEditorInstance(videoId()).then((result) => {
      if (result.status !== "ok") return;
      const ws = new WebSocket(`ws://localhost:${result.data}/frames-ws`);

      ws.binaryType = "arraybuffer";

      ws.onmessage = (event) => {
        const ctx = canvasRef()?.getContext("2d");
        if (!ctx) return;

        const clamped = new Uint8ClampedArray(event.data);
        const imageData = new ImageData(
          clamped,
          OUTPUT_SIZE.width,
          OUTPUT_SIZE.height
        );

        ctx.putImageData(imageData, 0, 0);
      };
    });
  });

  const renderFrame = throttle((time: number) => {
    events.renderFrameEvent.emit({
      frame_number: Math.floor(time * 30),
      project: state,
    });
  }, 10);

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
        await commands.stopPlayback(videoId());
        setPlaying(false);
      } else {
        await commands.startPlayback(videoId(), state);
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
                <EditorButton leftIcon={<IconCapCrop />}>Crop</EditorButton>
                <PresetsDropdown />
              </div>
              <div class="flex flex-row place-items-center gap-2">
                <EditorButton leftIcon={<IconCapUndo />}>Undo</EditorButton>
                <EditorButton leftIcon={<IconCapRedo />}>Redo</EditorButton>
              </div>
            </div>
            <div class="bg-gray-100 flex items-center justify-center flex-1 flex-row object-contain p-4">
              <canvas
                class="bg-blue-50 w-full"
                ref={setCanvasRef}
                id="canvas"
                width={OUTPUT_SIZE.width}
                height={OUTPUT_SIZE.height}
              />
            </div>
            <div class="flex flex-row items-center p-[0.75rem]">
              <div class="flex-1" />
              <div class="flex flex-row items-center justify-center gap-[0.5rem] text-gray-400 text-[0.875rem]">
                <span>0:00.00</span>
                <IconCapFrameFirst class="size-[1.2rem]" />
                {!playing() ? (
                  <button
                    type="button"
                    onClick={() =>
                      commands
                        .startPlayback(videoId(), state)
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
                        .stopPlayback(videoId())
                        .then(() => setPlaying(false))
                    }
                  >
                    <IconCapStopCircle class="size-[1.5rem]" />
                  </button>
                )}
                <IconCapFrameLast class="size-[1rem]" />
                <span>8:32.16</span>
              </div>
              <div class="flex-1 flex flex-row justify-end">
                <EditorButton<typeof KToggleButton>
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
                    (time() / duration) * (timelineBounds.width ?? 0)
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
                (playbackTime() / duration) * (timelineBounds.width ?? 0)
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
                  videoId(),
                  Math.round(30 * duration * ((e.clientX - left) / width))
                );
              }}
              onMouseMove={(e) => {
                const { left, width } = e.currentTarget.getBoundingClientRect();
                setPreviewTime(duration * ((e.clientX - left) / width));
              }}
              onMouseLeave={() => {
                setPreviewTime(undefined);
              }}
            >
              <span class="text-black-transparent-60 text-[0.625rem]">
                0:00
              </span>
              <span class="text-black-transparent-60 text-[0.625rem] ml-auto">
                {Math.floor(duration / 60)}:{Math.round(duration % 60)}
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

function Header() {
  const [params] = useSearchParams<{ path: string }>();
  const { state, canvasRef } = useEditorContext();

  return (
    <header
      class="flex flex-row justify-between items-center"
      data-tauri-drag-region
    >
      <div class="flex flex-row items-center gap-[0.5rem] text-[0.875rem]">
        <div class="flex flex-row items-center gap-[0.375rem]">
          <div class="size-[1.5rem] rounded-[0.25rem] bg-gray-500 bg-black" />
          <span>Adria Studio Workspace</span>
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

import { save } from "@tauri-apps/plugin-dialog";
import { Channel } from "@tauri-apps/api/core";

function ExportButton() {
  const { videoId, state: project } = useEditorContext();

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
              .renderToFile(p, videoId(), project, progress)
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
                    ></div>
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
  const { selectedTab, setSelectedTab, state, setState } = useEditorContext();

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
              value={state.background.source.type}
              onChange={(v) => {
                const tab = v as BackgroundSource["type"];

                switch (tab) {
                  case "wallpaper": {
                    setState("background", "source", {
                      type: "wallpaper",
                      id: 0,
                    });
                    return;
                  }
                  case "image": {
                    setState("background", "source", {
                      type: "image",
                      path: null,
                    });
                    return;
                  }
                  case "color": {
                    setState("background", "source", {
                      type: "color",
                      value: DEFAULT_FROM,
                    });
                    return;
                  }
                  case "gradient": {
                    setState("background", "source", {
                      type: "gradient",
                      from: DEFAULT_FROM,
                      to: DEFAULT_TO,
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
                            state.background.source.type
                          ) === i ||
                            BACKGROUND_SOURCES_LIST.indexOf(
                              state.background.source.type
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
                    state.background.source.type === "wallpaper"
                      ? state.background.source.id.toString()
                      : undefined
                  }
                  onChange={(v) =>
                    setState("background", "source", {
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
                    state.background.source.type === "color" &&
                    state.background.source
                  }
                >
                  {(source) => (
                    <RgbInput
                      value={source().value}
                      onChange={(value) =>
                        setState("background", "source", {
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
                    state.background.source.type === "gradient" &&
                    state.background.source
                  }
                >
                  {(source) => (
                    <>
                      <RgbInput
                        value={source().from}
                        onChange={(from) =>
                          setState("background", "source", {
                            type: "gradient",
                            from,
                            to: source().to,
                          })
                        }
                      />
                      <RgbInput
                        value={source().to}
                        onChange={(to) =>
                          setState("background", "source", {
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
              value={[state.background.blur]}
              onChange={(v) => setState("background", "blur", v[0])}
              minValue={0}
              maxValue={100}
            />
          </Field>
          <Field name="Padding" icon={<IconCapPadding />}>
            <Slider
              value={[state.background.padding]}
              onChange={(v) => setState("background", "padding", v[0])}
              minValue={0}
              maxValue={40}
            />
          </Field>
          <Field name="Rounded Corners" icon={<IconCapCorners />}>
            <Slider
              value={[state.background.rounding]}
              onChange={(v) => setState("background", "rounding", v[0])}
              minValue={0}
              maxValue={100}
            />
          </Field>
          <Field name="Inset" icon={<IconCapInset />}>
            <Slider
              value={[state.background.inset]}
              onChange={(v) => setState("background", "inset", v[0])}
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
                  checked={state.camera.hide}
                  onChange={(hide) => setState("camera", "hide", hide)}
                />
              </Subfield>
              <Subfield name="Mirror Camera">
                <Toggle
                  checked={state.camera.mirror}
                  onChange={(mirror) => setState("camera", "mirror", mirror)}
                />
              </Subfield>
              <div>
                <Subfield name="Camera Position" class="mt-[0.75rem]" />
                <KRadioGroup
                  value={`${state.camera.position.x}:${state.camera.position.y}`}
                  onChange={(v) => {
                    const [x, y] = v.split(":");
                    setState("camera", "position", { x, y } as any);
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
                          onClick={() => setState("camera", "position", item)}
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
              value={[state.camera.rounding]}
              onChange={(v) => setState("camera", "rounding", v[0])}
              minValue={0}
              maxValue={100}
            />
          </Field>
          <Field name="Shadow" icon={<IconCapShadow />}>
            <Slider
              value={[state.camera.shadow]}
              onChange={(v) => setState("camera", "shadow", v[0])}
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
                <Toggle />
              </Subfield>
            </div>
          </Field>
        </KTabs.Content>
        <KTabs.Content value="cursor" class="flex flex-col gap-6">
          <Field name="Cursor" icon={<IconCapCursor />}>
            <Subfield name="Hide cursor when not moving">
              <Toggle />
            </Subfield>
          </Field>
          <Field name="Size" icon={<IconCapEnlarge />}>
            <Slider
              value={[state.cursor.size]}
              onChange={(v) => setState("cursor", "size", v[0])}
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
                      type="button"
                      onClick={() => setState("cursor", "type", item.type)}
                      data-selected={state.cursor.type === item.type}
                      class="border border-black-transparent-5 bg-gray-100 rounded-lg p-[0.625rem] text-gray-400 data-[selected='true']:text-gray-500 focus-visible:outline-blue-300 focus-visible:outline outline-1 outline-offset-1"
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
              <Toggle />
            </Subfield>
          </Field>
        </KTabs.Content>
      </div>
    </KTabs>
  );
}

function AspectRatioSelect() {
  const { state, setState } = useEditorContext();

  return (
    <KSelect<AspectRatio | "auto">
      value={state.aspectRatio ?? "auto"}
      onChange={(v) => {
        if (v === null) return;
        setState("aspectRatio", v === "auto" ? null : v);
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
        <KSelect.Value>
          {(state) => (
            <>
              {state.selectedOption() === "auto"
                ? "Auto"
                : ASPECT_RATIOS[state.selectedOption()].name}
            </>
          )}
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
  const { setDialog } = useEditorContext();

  return (
    <KDropdownMenu gutter={8}>
      <EditorButton<typeof KDropdownMenu.Trigger>
        as={KDropdownMenu.Trigger}
        leftIcon={<IconCapPresets />}
      >
        Presets
      </EditorButton>
      <KDropdownMenu.Portal>
        <PopperContent<typeof KDropdownMenu.Content>
          as={KDropdownMenu.Content}
          class={cx("w-72 max-h-56", topLeftAnimateClasses)}
        >
          <MenuItemList<typeof KDropdownMenu.Group>
            as={KDropdownMenu.Group}
            class="flex-1 overflow-y-auto scrollbar-none"
          >
            <For
              each={[
                "Preset One",
                "Preset Two",
                "Preset Three",
                "Preset Four",
                "Preset Five",
                "Preset Six",
                "Preset Seven",
                "Preset Eight",
              ]}
            >
              {(preset, i) => {
                const [showSettings, setShowSettings] = createSignal(false);

                return (
                  <KDropdownMenu.Sub gutter={16}>
                    <MenuItem<typeof KDropdownMenu.SubTrigger>
                      as={KDropdownMenu.SubTrigger}
                      onFocusIn={() => setShowSettings(false)}
                      onClick={() => setShowSettings(false)}
                    >
                      <span class="mr-auto">{preset}</span>
                      <Show when={i() === 1}>
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
                            <DropdownItem>Apply</DropdownItem>
                            <DropdownItem>Set as default</DropdownItem>
                            <DropdownItem
                              onSelect={() =>
                                setDialog({
                                  type: "renamePreset",
                                  presetId: preset,
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
                                  presetId: preset,
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
      </KDropdownMenu.Portal>
    </KDropdownMenu>
  );
}

function Dialogs() {
  const { dialog, setDialog } = useEditorContext();

  return (
    <Dialog.Root
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
              <DialogContent
                title="Create Preset"
                confirm={
                  <Dialog.ConfirmButton
                    onClick={() => setDialog((d) => ({ ...d, open: false }))}
                  >
                    Create
                  </Dialog.ConfirmButton>
                }
              >
                <Subfield name="Name" required />
                <Input class="mt-[0.25rem]" />
                <Subfield name="Set as default" class="mt-[0.75rem]">
                  <Toggle />
                </Subfield>
              </DialogContent>
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "renamePreset") return d;
              })()}
            >
              {(dialog) => (
                <DialogContent
                  title="Rename Preset"
                  confirm={
                    <Dialog.ConfirmButton
                      onClick={() => setDialog((d) => ({ ...d, open: false }))}
                    >
                      Rename
                    </Dialog.ConfirmButton>
                  }
                >
                  <Subfield name="Name" required />
                  <Input value={dialog().presetId} />
                </DialogContent>
              )}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "deletePreset") return d;
              })()}
            >
              {(_dialog) => (
                <DialogContent
                  title="Delete Preset"
                  confirm={
                    <Dialog.ConfirmButton
                      variant="destructive"
                      onClick={() => setDialog((d) => ({ ...d, open: false }))}
                    >
                      Delete
                    </Dialog.ConfirmButton>
                  }
                >
                  <p class="text-gray-400">
                    Lorem ipsum dolor sit amet, consectetur adipiscing elit sed
                    do eiusmod tempor incididunt ut labore et dolore magna
                    aliqua.
                  </p>
                </DialogContent>
              )}
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
  const [text, setText] = createSignal(rgbToHex(props.value));
  let prevHex = rgbToHex(props.value);

  return (
    <div class="flex flex-row items-center gap-[0.75rem]">
      <div
        class="size-[3rem] rounded-[0.5rem]"
        style={{
          "background-color": rgbToHex(props.value),
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
