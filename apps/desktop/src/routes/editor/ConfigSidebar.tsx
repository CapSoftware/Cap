import {
  RadioGroup as KRadioGroup,
  RadioGroup,
} from "@kobalte/core/radio-group";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { cx } from "cva";
import { batch, type Component, createRoot, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createWritableMemo } from "@solid-primitives/memo";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { produce } from "solid-js/store";

import type {
  BackgroundSource,
  CursorType,
  CursorAnimationStyle,
} from "~/utils/tauri";
import { useEditorContext } from "./context";
import {
  ComingSoonTooltip,
  EditorButton,
  Field,
  Subfield,
  Toggle,
  Slider,
} from "./ui";
import {
  DEFAULT_GRADIENT_FROM,
  DEFAULT_GRADIENT_TO,
  DEFAULT_PROJECT_CONFIG,
} from "./projectConfig";

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

const CURSOR_ANIMATION_STYLES: Record<CursorAnimationStyle, string> = {
  slow: "Slow & Smooth",
  regular: "Regular",
  fast: "Fast & Responsive",
} as const;

export function ConfigSidebar() {
  const {
    selectedTab,
    setSelectedTab,
    project,
    setProject,
    editorInstance,
    state,
    setState,
  } = useEditorContext();

  const backgrounds: {
    [K in BackgroundSource["type"]]: Extract<BackgroundSource, { type: K }>;
  } = {
    wallpaper: {
      type: "wallpaper",
      id: 0,
    },
    image: {
      type: "image",
      path: null,
    },
    color: {
      type: "color",
      value: DEFAULT_GRADIENT_FROM,
    },
    gradient: {
      type: "gradient",
      from: DEFAULT_GRADIENT_FROM,
      to: DEFAULT_GRADIENT_TO,
    },
  };

  return (
    <KTabs
      value={selectedTab()}
      class="flex flex-col shrink-0 overflow-x-hidden overflow-y-hidden flex-1 max-w-[25.5rem] z-10 bg-gray-50 relative"
    >
      <KTabs.List class="h-[3.5rem] flex flex-row divide-x divide-gray-200 text-black/50 text-lg relative z-40 overflow-x-auto border-b border-gray-200 shrink-0">
        <For
          each={[
            { id: "background" as const, icon: IconCapImage },
            {
              id: "camera" as const,
              icon: IconCapCamera,
              disabled: editorInstance.recordings.segments.every(
                (s) => s.camera === null
              ),
            },
            // {
            //   id: "transcript" as const,
            //   icon: IconCapMessageBubble,
            // },
            { id: "audio" as const, icon: IconCapAudioOn },
            { id: "cursor" as const, icon: IconCapCursor },
            { id: "hotkeys" as const, icon: IconCapHotkeys },
          ]}
        >
          {(item) => (
            <KTabs.Trigger
              value={item.id}
              class="flex-1 text-gray-400 ui-selected:text-gray-500 z-10 disabled:text-gray-300"
              onClick={() => setSelectedTab(item.id)}
              disabled={item.disabled}
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
                      ...backgrounds.wallpaper,
                    });
                    return;
                  }
                  case "image": {
                    setProject("background", "source", {
                      ...backgrounds.image,
                    });
                    return;
                  }
                  case "color": {
                    setProject("background", "source", {
                      ...backgrounds.color,
                    });
                    return;
                  }
                  case "gradient": {
                    setProject("background", "source", {
                      ...backgrounds.gradient,
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
                  {(item) => {
                    const comingSoon = item === "wallpaper" || item === "image";

                    const el = (props?: object) => (
                      <KTabs.Trigger
                        class="flex-1 text-gray-400 py-1 z-10 ui-selected:text-gray-500 peer outline-none transition-colors duration-100"
                        value={item}
                        disabled={comingSoon}
                        {...props}
                      >
                        {BACKGROUND_SOURCES[item]}
                      </KTabs.Trigger>
                    );

                    if (comingSoon) return <ComingSoonTooltip as={el} />;

                    return el({});
                  }}
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
                  onChange={(v) => {
                    backgrounds.wallpaper = {
                      type: "wallpaper",
                      id: Number(v),
                    };
                    setProject("background", "source", backgrounds.wallpaper);
                  }}
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
                      onChange={(value) => {
                        backgrounds.color = {
                          type: "color",
                          value,
                        };
                        setProject("background", "source", backgrounds.color);
                      }}
                    />
                  )}
                </Show>
              </KTabs.Content>
              <KTabs.Content
                value="gradient"
                class="flex flex-row items-center justify-between"
              >
                <Show
                  when={
                    project.background.source.type === "gradient" &&
                    project.background.source
                  }
                >
                  {(source) => {
                    const max = 360;

                    const { history } = useEditorContext();

                    const angle = () => source().angle ?? 90;

                    return (
                      <>
                        <RgbInput
                          value={source().from}
                          onChange={(from) => {
                            backgrounds.gradient.from = from;
                            setProject("background", "source", {
                              type: "gradient",
                              from,
                            });
                          }}
                        />
                        <RgbInput
                          value={source().to}
                          onChange={(to) => {
                            backgrounds.gradient.to = to;
                            setProject("background", "source", {
                              type: "gradient",
                              to,
                            });
                          }}
                        />
                        <div
                          class="rounded-full size-12 bg-gray-50 border border-gray-200 relative p-1 flex flex-col items-center cursor-ns-resize shrink-0"
                          style={{ transform: `rotate(${angle()}deg)` }}
                          onMouseDown={(downEvent) => {
                            const start = angle();
                            const resumeHistory = history.pause();

                            createRoot((dispose) =>
                              createEventListenerMap(window, {
                                mouseup: () => {
                                  resumeHistory();
                                  dispose();
                                },
                                mousemove: (moveEvent) => {
                                  const rawNewAngle =
                                    Math.round(
                                      start +
                                        (downEvent.clientY - moveEvent.clientY)
                                    ) % max;
                                  const newAngle = moveEvent.shiftKey
                                    ? rawNewAngle
                                    : Math.round(rawNewAngle / 45) * 45;

                                  setProject("background", "source", {
                                    type: "gradient",
                                    angle:
                                      newAngle < 0 ? newAngle + max : newAngle,
                                  });
                                },
                              })
                            );
                          }}
                        >
                          <div class="bg-blue-300 size-2 rounded-full" />
                        </div>
                      </>
                    );
                  }}
                </Show>
              </KTabs.Content>
            </KTabs>
          </Field>

          <ComingSoonTooltip>
            <Field name="Background Blur" icon={<IconCapBlur />}>
              <Slider
                disabled
                value={[project.background.blur]}
                onChange={(v) => setProject("background", "blur", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip>
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
          <ComingSoonTooltip>
            <Field name="Inset" icon={<IconCapInset />}>
              <Slider
                disabled
                value={[project.background.inset]}
                onChange={(v) => setProject("background", "inset", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip>
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
          <Field
            name="Size"
            icon={<IconCapEnlarge />}
            value={`${project.camera.size}%`}
          >
            <Slider
              value={[project.camera.size]}
              onChange={(v) => setProject("camera", "size", v[0])}
              minValue={20}
              maxValue={80}
              step={0.1}
            />
          </Field>
          {window.FLAGS.zoom && (
            <Field
              name="Size During Zoom"
              icon={<IconCapEnlarge />}
              value={`${
                project.camera.zoom_size ??
                DEFAULT_PROJECT_CONFIG.camera.zoom_size
              }%`}
            >
              <Slider
                value={[
                  project.camera.zoom_size ??
                    DEFAULT_PROJECT_CONFIG.camera.zoom_size,
                ]}
                onChange={(v) => setProject("camera", "zoom_size", v[0])}
                minValue={10}
                maxValue={60}
                step={0.1}
              />
            </Field>
          )}
          <Field name="Rounded Corners" icon={<IconCapCorners />}>
            <Slider
              value={[
                project.camera.rounding ??
                  DEFAULT_PROJECT_CONFIG.camera.rounding,
              ]}
              onChange={(v) => setProject("camera", "rounding", v[0])}
              minValue={0}
              maxValue={100}
              step={0.1}
            />
          </Field>
          <ComingSoonTooltip>
            <Field name="Shadow" icon={<IconCapShadow />}>
              <Slider
                disabled
                value={[project.camera.shadow]}
                onChange={(v) => setProject("camera", "shadow", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip>
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
              <ComingSoonTooltip>
                <Subfield name="Mute Audio">
                  <Toggle disabled />
                </Subfield>
              </ComingSoonTooltip>
              <ComingSoonTooltip>
                <Subfield name="Improve Mic Quality">
                  <Toggle disabled />
                </Subfield>
              </ComingSoonTooltip>
            </div>
          </Field>
        </KTabs.Content>
        <KTabs.Content value="cursor" class="flex flex-col gap-6">
          <Field name="Cursor" icon={<IconCapCursor />}>
            <ComingSoonTooltip>
              <Subfield name="Hide cursor when not moving">
                <Toggle disabled />
              </Subfield>
            </ComingSoonTooltip>
          </Field>
          <Field name="Size" icon={<IconCapEnlarge />}>
            <ComingSoonTooltip>
              <Slider
                disabled
                value={[project.cursor.size]}
                onChange={(v) => setProject("cursor", "size", v[0])}
                minValue={20}
                maxValue={300}
                step={1}
              />
            </ComingSoonTooltip>
          </Field>
          {window.FLAGS.zoom && (
            <Field name="Animation Style" icon={<IconLucideRabbit />}>
              <RadioGroup
                defaultValue="regular"
                value={project.cursor.animationStyle}
                onChange={(value) => {
                  console.log("Changing animation style to:", value);
                  setProject(
                    "cursor",
                    "animationStyle",
                    value as CursorAnimationStyle
                  );
                }}
                class="flex flex-col gap-2"
              >
                {(
                  Object.entries(CURSOR_ANIMATION_STYLES) as [
                    CursorAnimationStyle,
                    string
                  ][]
                ).map(([value, label]) => (
                  <RadioGroup.Item value={value} class="flex items-center">
                    <RadioGroup.ItemInput class="peer sr-only" />
                    <RadioGroup.ItemControl
                      class={cx(
                        "w-4 h-4 rounded-full border border-gray-300 mr-2",
                        "relative after:absolute after:inset-0 after:m-auto after:block after:w-2 after:h-2 after:rounded-full",
                        "after:transition-colors after:duration-200",
                        "peer-checked:border-blue-500 peer-checked:after:bg-blue-400",
                        "peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/50",
                        "peer-disabled:opacity-50"
                      )}
                    />
                    <span
                      class={cx(
                        "text-gray-500",
                        "peer-checked:text-gray-900",
                        "peer-disabled:opacity-50"
                      )}
                    >
                      {label}
                    </span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup>
            </Field>
          )}
        </KTabs.Content>
        <KTabs.Content value="hotkeys">
          <Field name="Hotkeys" icon={<IconCapHotkeys />}>
            <ComingSoonTooltip>
              <Subfield name="Show hotkeys">
                <Toggle disabled />
              </Subfield>
            </ComingSoonTooltip>
          </Field>
        </KTabs.Content>
      </div>
      <Show
        when={(() => {
          const selection =
            state.timelineSelection?.type === "zoom" && state.timelineSelection;
          if (!selection) return;

          const segment = project.timeline?.zoomSegments?.[selection.index];
          if (!segment) return;

          return { selection, segment };
        })()}
      >
        {(value) => {
          const zoomPercentage = () => {
            const amount = value().segment.amount;
            return `${amount.toFixed(1)}x`;
          };

          const zoomAmount = () => {
            const selection = state.timelineSelection;
            if (!selection || selection.type !== "zoom") return;

            const segment = project.timeline?.zoomSegments?.[selection.index];
            return segment?.amount;
          };

          return (
            <div
              data-visible={state.timelineSelection?.type === "zoom"}
              class="absolute inset-0 p-[0.75rem] text-[0.875rem] space-y-6 bg-gray-50 z-50 animate-in slide-in-from-bottom-2 fade-in"
            >
              <div class="flex flex-row justify-between items-center">
                <div class="flex items-center gap-2">
                  <EditorButton
                    onClick={() => setState("timelineSelection", null)}
                    leftIcon={<IconLucideCheck />}
                  >
                    Done
                  </EditorButton>
                </div>
                <EditorButton
                  variant="danger"
                  onClick={() => {
                    const index = value().selection.index;

                    batch(() => {
                      setState("timelineSelection", null);
                      setProject(
                        "timeline",
                        "zoomSegments",
                        produce((s) => {
                          if (!s) return;
                          return s.splice(index, 1);
                        })
                      );
                    });
                  }}
                  leftIcon={<IconCapTrash />}
                >
                  Delete
                </EditorButton>
              </div>
              <Field
                name={`Zoom Amount (${zoomPercentage()})`}
                icon={<IconLucideSearch />}
              >
                <Slider
                  value={[value().segment.amount]}
                  onChange={(v) =>
                    setProject(
                      "timeline",
                      "zoomSegments",
                      value().selection.index,
                      "amount",
                      v[0]
                    )
                  }
                  minValue={1}
                  maxValue={2.5}
                  step={0.001}
                />
              </Field>
              <Field name="Zoom Mode" icon={<IconCapSettings />}>
                <KTabs class="space-y-6">
                  <KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
                    <KTabs.Trigger
                      value="auto"
                      class="flex-1 text-gray-400 py-1 z-10 ui-selected:text-gray-500 peer outline-none transition-colors duration-100"
                      // onClick={() => setSelectedTab(item.id)}
                      disabled
                    >
                      Auto
                    </KTabs.Trigger>
                    <KTabs.Trigger
                      value="manual"
                      class="flex-1 text-gray-400 py-1 z-10 ui-selected:text-gray-500 peer outline-none transition-colors duration-100"
                      // onClick={() => setSelectedTab(item.id)}
                    >
                      Manual
                    </KTabs.Trigger>
                    <KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden">
                      <div class="bg-gray-100 flex-1" />
                    </KTabs.Indicator>
                  </KTabs.List>
                  <KTabs.Content value="manual">
                    <Show
                      when={(() => {
                        const m = value().segment.mode;
                        if (m === "auto") return;
                        return m.manual;
                      })()}
                    >
                      {(mode) => (
                        <div class="w-full h-52 bg-gray-100 rounded-xl p-1">
                          <div
                            class="w-full h-full bg-blue-400 rounded-lg relative"
                            onMouseDown={(downEvent) => {
                              const bounds =
                                downEvent.currentTarget.getBoundingClientRect();

                              createRoot((dispose) => {
                                createEventListenerMap(window, {
                                  mouseup: () => dispose(),
                                  mousemove: (moveEvent) => {
                                    setProject(
                                      "timeline",
                                      "zoomSegments",
                                      value().selection.index,
                                      "mode",
                                      "manual",
                                      {
                                        x: Math.max(
                                          Math.min(
                                            (moveEvent.clientX - bounds.left) /
                                              bounds.width,
                                            1
                                          ),
                                          0
                                        ),
                                        y: Math.max(
                                          Math.min(
                                            (moveEvent.clientY - bounds.top) /
                                              bounds.height,
                                            1
                                          ),
                                          0
                                        ),
                                      }
                                    );
                                  },
                                });
                              });
                            }}
                          >
                            <div
                              class="absolute w-6 h-6 rounded-full bg-gray-50 border border-gray-400 -translate-x-1/2 -translate-y-1/2"
                              style={{
                                left: `${mode().x * 100}%`,
                                top: `${mode().y * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </Show>
                  </KTabs.Content>
                </KTabs>
              </Field>
            </div>
          );
        }}
      </Show>
    </KTabs>
  );
}

function RgbInput(props: {
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}) {
  const [text, setText] = createWritableMemo(() => rgbToHex(props.value));
  let prevHex = rgbToHex(props.value);

  let colorInput!: HTMLInputElement;

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
        ref={colorInput}
        type="color"
        class="absolute left-0 bottom-0 w-[3rem] opacity-0"
        onChange={(e) => {
          const value = hexToRgb(e.target.value);
          if (value) props.onChange(value);
        }}
      />
      <input
        class="w-[5rem] p-[0.375rem] border text-gray-400 rounded-[0.5rem] bg-gray-50"
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
