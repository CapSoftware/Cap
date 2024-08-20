import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Select as KSelect } from "@kobalte/core/select";
import { Slider as KSlider } from "@kobalte/core/slider";
import { Switch as KSwitch } from "@kobalte/core/switch";
import { Dialog as KDialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";

import { useSearchParams } from "@solidjs/router";
import { cx } from "cva";
import {
  type ComponentProps,
  For,
  type JSX,
  Match,
  type ParentProps,
  Show,
  Switch,
  createSignal,
  mergeProps,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { createStore } from "solid-js/store";

const ASPECT_RATIOS = [
  { name: "Wide", ratio: [16, 9] },
  { name: "Vertical", ratio: [9, 16] },
  { name: "Square", ratio: [1, 1] },
  { name: "Classic", ratio: [4, 3] },
  { name: "Tall", ratio: [3, 4] },
] as const;

type AspectRatioName = (typeof ASPECT_RATIOS)[number]["name"];

type CurrentDialog =
  | { type: "createPreset" }
  | { type: "renamePreset"; presetId: string }
  | { type: "deletePreset"; presetId: string }
  | { type: "crop" };

type CameraPosition = { x: "l" | "c" | "r"; y: "t" | "b" };
type CursorType = "pointer" | "circle";

type BackgroundSource =
  | { type: "Wallpaper"; id: number }
  | { type: "Image"; path: string | null }
  | { type: "Color"; value: string }
  | { type: "Gradient"; from: string; to: string };
type BackgroundSourceType = BackgroundSource["type"];

type State = {
  aspectRatio: AspectRatioName | "Auto";
  background: {
    source: BackgroundSource;
    blur: number;
    padding: number;
    rounding: number;
    inset: number;
  };
  camera: {
    hide: boolean;
    mirror: boolean;
    position: CameraPosition;
    rounding: number;
    shadow: number;
  };
  audio: {
    mute: boolean;
    improve: boolean;
  };
  cursor: {
    hideWhenIdle: boolean;
    size: number;
    type: CursorType;
  };
  hotkeys: {
    show: boolean;
  };
};

export default function () {
  const [params] = useSearchParams<{ path: string }>();

  const [selectedTab, setSelectedTab] = createSignal<
    "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
  >("camera");

  const [state, setState] = createStore<State>({
    aspectRatio: "Auto",
    background: {
      source: { type: "Wallpaper", id: 0 },
      blur: 0,
      padding: 0,
      rounding: 0,
      inset: 0,
    },
    camera: {
      hide: false,
      mirror: false,
      position: { x: "r", y: "b" },
      rounding: 0,
      shadow: 0,
    },
    audio: {
      mute: false,
      improve: false,
    },
    cursor: {
      hideWhenIdle: false,
      size: 0,
      type: "pointer",
    },
    hotkeys: {
      show: false,
    },
  });

  const [dialog, setDialog] = createSignal<
    { open: false } | ({ open: boolean } & CurrentDialog)
  >({ open: false });

  return (
    <div
      class="p-5 flex flex-col gap-4 w-screen h-screen divide-y bg-gray-50 rounded-lg"
      data-tauri-drag-region
    >
      <header
        class="flex flex-row justify-between items-center"
        data-tauri-drag-region
      >
        <div class="font-medium" data-tauri-drag-region>
          {params.path?.split("/").at(-1)}
        </div>
        <div class="flex flex-row gap-4 font-medium" data-tauri-drag-region>
          <button
            type="button"
            class="px-5 py-1.5 rounded-full bg-neutral-200/60 flex flex-row gap-2 items-center"
          >
            cap.link/todo
            <IconLucideCopy class="inline size-4 text-black/40" />
          </button>
          <button
            type="button"
            class="px-5 py-1.5 rounded-full bg-blue-500 text-white"
          >
            Save
          </button>
        </div>
      </header>
      <div class="rounded-2xl shadow border flex-1 flex flex-col divide-y bg-white">
        <div class="flex flex-row flex-1 divide-x overflow-y-hidden">
          <div class="flex flex-col divide-y flex-1">
            <div class="flex flex-row h-14 justify-between font-medium px-3 text-sm">
              <div class="flex flex-row items-center gap-2">
                <KSelect<AspectRatioName | "Auto">
                  defaultValue="Auto"
                  value={state.aspectRatio}
                  onChange={(v) => {
                    if (v) setState("aspectRatio", v);
                  }}
                  multiple={false}
                  options={["Auto", ...ASPECT_RATIOS.map((r) => r.name)]}
                  itemComponent={(props) => {
                    const item = () =>
                      ASPECT_RATIOS.find((r) => r.name === props.item.rawValue);

                    return (
                      <KSelect.Item
                        item={props.item}
                        class={popoverItemClasses}
                      >
                        <KSelect.ItemLabel>
                          {props.item.rawValue}
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
                          <IconLucideCircleCheck />
                        </KSelect.ItemIndicator>
                      </KSelect.Item>
                    );
                  }}
                  placement="top-start"
                >
                  <KSelect.Trigger type="button" class={actionButtonClasses}>
                    <IconLucideLayoutDashboard class="text-black/50" />
                    <KSelect.Value>
                      {(state) => <>{state.selectedOption()}</>}
                    </KSelect.Value>
                    <KSelect.Icon>
                      <IconLucideChevronDown />
                    </KSelect.Icon>
                  </KSelect.Trigger>
                  <KSelect.Portal>
                    <KSelect.Content
                      class={cx(
                        popoverContentClasses,
                        popoverTopLeftAnimateClasses
                      )}
                    >
                      <KSelect.Listbox class={cx("w-48", popoverListClasses)} />
                    </KSelect.Content>
                  </KSelect.Portal>
                </KSelect>
                <button type="button" class={actionButtonClasses}>
                  <IconLucideCrop class="text-black/50" />
                  Crop
                </button>
                <DropdownMenu gutter={8}>
                  <DropdownMenu.Trigger class={actionButtonClasses}>
                    <IconLucideWandSparkles class="text-black/50" />
                    Presets
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      class={cx(
                        "w-72 max-h-56",
                        popoverContentClasses,
                        popoverTopLeftAnimateClasses
                      )}
                    >
                      <DropdownMenu.Group
                        class={cx(
                          popoverListClasses,
                          "flex-1 overflow-y-auto scrollbar-none"
                        )}
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
                            const [showSettings, setShowSettings] =
                              createSignal(false);

                            return (
                              <DropdownMenu.Sub gutter={16}>
                                <DropdownMenu.SubTrigger
                                  class={popoverItemClasses}
                                  onFocusIn={() => setShowSettings(false)}
                                  onClick={() => setShowSettings(false)}
                                >
                                  <span class="mr-auto">{preset}</span>
                                  <Show when={i() === 1}>
                                    <span class="bg-gray-500/20 text-gray-400 rounded-full px-2 py-0.5 text-xs">
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
                                    <IconLucideSettings />
                                  </button>
                                </DropdownMenu.SubTrigger>
                                <DropdownMenu.Portal>
                                  {showSettings() && (
                                    <DropdownMenu.SubContent
                                      class={cx(
                                        "animate-in fade-in slide-in-from-left-1 w-44",
                                        popoverListClasses,
                                        popoverContentClasses
                                      )}
                                    >
                                      <DropdownMenu.Item
                                        class={popoverItemClasses}
                                      >
                                        Apply
                                      </DropdownMenu.Item>
                                      <DropdownMenu.Item
                                        class={popoverItemClasses}
                                      >
                                        Set as default
                                      </DropdownMenu.Item>
                                      <DropdownMenu.Item
                                        class={popoverItemClasses}
                                        onSelect={() =>
                                          setDialog({
                                            type: "renamePreset",
                                            presetId: preset,
                                            open: true,
                                          })
                                        }
                                      >
                                        Rename
                                      </DropdownMenu.Item>
                                      <DropdownMenu.Item
                                        class={popoverItemClasses}
                                        onClick={() =>
                                          setDialog({
                                            type: "deletePreset",
                                            presetId: preset,
                                            open: true,
                                          })
                                        }
                                      >
                                        Delete
                                      </DropdownMenu.Item>
                                    </DropdownMenu.SubContent>
                                  )}
                                </DropdownMenu.Portal>
                              </DropdownMenu.Sub>
                            );
                          }}
                        </For>
                      </DropdownMenu.Group>
                      <DropdownMenu.Group
                        class={cx(popoverListClasses, "border-t")}
                      >
                        <DropdownMenu.Item
                          class={popoverItemClasses}
                          onSelect={() =>
                            setDialog({ type: "createPreset", open: true })
                          }
                        >
                          <span>Create new preset</span>
                          <IconLucideCirclePlus class="ml-auto" />
                        </DropdownMenu.Item>
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
              <div class="flex flex-row place-items-center gap-2">
                <button type="button" class={actionButtonClasses}>
                  <IconLucideUndo2 class="text-black/50" />
                  Undo
                </button>
                <button type="button" class={actionButtonClasses}>
                  <IconLucideRedo2 class="text-black/50" />
                  Redo
                </button>
              </div>
            </div>
            <div class="bg-gray-50 flex items-center justify-center flex-1" />
            <div class="h-12 flex flex-row items-center justify-center gap-3 text-neutral-500 font-medium">
              <span>0:00.00</span>
              <IconLucideRewind />
              <IconLucideCircleStop />
              <IconLucideFastForward />
              <span>8:32.16</span>
            </div>
          </div>
          <Tabs
            value={selectedTab()}
            class="flex flex-col font-medium text-sm overflow-x-hidden overflow-y-hidden w-[26.5rem]"
          >
            <Tabs.List class="h-14 flex flex-row divide-x text-black/50 text-lg relative z-40 overflow-x-auto border-b">
              <For
                each={[
                  { id: "background" as const, icon: IconLucideImage },
                  { id: "camera" as const, icon: IconLucideVideo },
                  {
                    id: "transcript" as const,
                    icon: IconLucideMessageSquareMore,
                  },
                  { id: "audio" as const, icon: IconLucideVolume1 },
                  { id: "cursor" as const, icon: IconLucideMousePointer2 },
                  { id: "hotkeys" as const, icon: IconLucideCommand },
                ]}
              >
                {(item) => (
                  <Tabs.Trigger
                    value={item.id}
                    class="flex-1 data-[selected='true']:text-black z-10"
                    onClick={() => setSelectedTab(item.id)}
                    data-selected={selectedTab() === item.id}
                  >
                    <Dynamic class="mx-auto" component={item.icon} />
                  </Tabs.Trigger>
                )}
              </For>
              <Tabs.Indicator class="absolute inset-0 transition-transform">
                <div class="bg-gray-100 w-full h-full" />
              </Tabs.Indicator>
            </Tabs.List>
            <Tabs.Content
              value="background"
              class="p-3 flex flex-col gap-6 overflow-y-auto"
            >
              <Field name="Background" icon={<IconLucideImage />}>
                <Tabs
                  class="space-y-3"
                  value={state.background.source.type}
                  onChange={(v) => {
                    const tab = v as BackgroundSourceType;

                    switch (tab) {
                      case "Wallpaper": {
                        setState("background", "source", {
                          type: "Wallpaper",
                          id: 0,
                        });
                        return;
                      }
                      case "Image": {
                        setState("background", "source", {
                          type: "Image",
                          path: null,
                        });
                        return;
                      }
                      case "Color": {
                        setState("background", "source", {
                          type: "Color",
                          value: "#4785FF",
                        });
                        return;
                      }
                      case "Gradient": {
                        setState("background", "source", {
                          type: "Gradient",
                          from: "#4785FF",
                          to: "#FF4766",
                        });
                        return;
                      }
                    }
                  }}
                >
                  <Tabs.List class="border flex flex-row rounded-lg relative overflow-hidden">
                    <For each={["Wallpaper", "Image", "Color", "Gradient"]}>
                      {(item) => (
                        <Tabs.Trigger
                          class="flex-1 text-gray-400 py-1 z-10 data-[highlighted]:text-black"
                          value={item}
                        >
                          {item}
                        </Tabs.Trigger>
                      )}
                    </For>
                    <Tabs.Indicator class="absolute inset-px transition-transform">
                      <div class="bg-gray-100 w-full h-full rounded-lg" />
                    </Tabs.Indicator>
                  </Tabs.List>
                  <Tabs.Content value="Wallpaper">
                    <div class="grid grid-cols-7 grid-rows-2 gap-2 h-[6.8rem]">
                      <For each={[...Array(14).keys()]}>
                        {(_, i) => (
                          <button
                            type="button"
                            data-selected={
                              state.background.source.type === "Wallpaper" &&
                              state.background.source.id === i()
                            }
                            onClick={() =>
                              setState("background", "source", {
                                type: "Wallpaper",
                                id: i(),
                              })
                            }
                            class="border border-gray-200 data-[selected='true']:border-blue-500 bg-gray-100 rounded-lg col-span-1 row-span-1"
                          />
                        )}
                      </For>
                    </div>
                  </Tabs.Content>
                  <Tabs.Content value="Image">
                    <button
                      type="button"
                      class="h-20 bg-gray-50 w-full rounded-md border flex flex-col items-center justify-center gap-2 text-gray-400"
                    >
                      <IconLucideImage class="size-6" />
                      <span>Click to select or drag and drop image</span>
                    </button>
                  </Tabs.Content>
                  <Tabs.Content
                    value="Color"
                    class="flex flex-row items-center gap-3"
                  >
                    <div
                      class="size-12 rounded-md"
                      style={{ "background-color": "#4785FF" }}
                    />
                    <input
                      class="border p-1 text-gray-400 w-20 rounded-md"
                      value="#4785FF"
                    />
                  </Tabs.Content>
                  <Tabs.Content
                    value="Gradient"
                    class="flex flex-row items-center gap-3"
                  >
                    <div
                      class="size-12 rounded-md"
                      style={{ "background-color": "#4785FF" }}
                    />
                    <input
                      class="border p-1 text-gray-400 w-20 rounded-md"
                      value="#4785FF"
                    />
                    <br />
                    <div
                      class="size-12 rounded-md"
                      style={{ "background-color": "#FF4766" }}
                    />
                    <input
                      class="border p-1 text-gray-400 w-20 rounded-md"
                      value="#FF4766"
                    />
                  </Tabs.Content>
                </Tabs>
              </Field>
              <Field name="Background Blur" icon={<IconMdiBlur />}>
                <Slider
                  value={[state.background.blur]}
                  onChange={(v) => setState("background", "blur", v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Padding" icon={<IconHugeiconsDashedLine02 />}>
                <Slider
                  value={[state.background.padding]}
                  onChange={(v) => setState("background", "padding", v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Rounded Corners" icon={<IconLucideCircleDashed />}>
                <Slider
                  value={[state.background.rounding]}
                  onChange={(v) => setState("background", "rounding", v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Inset" icon={<IconLucideSquare />}>
                <Slider
                  value={[state.background.inset]}
                  onChange={(v) => setState("background", "inset", v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
            </Tabs.Content>
            <Tabs.Content
              value="camera"
              class="p-3 flex flex-col gap-6 overflow-y-auto"
            >
              <Field name="Camera" icon={<IconLucideVideo />}>
                <div class="flex flex-col gap-3">
                  <Subfield name="Hide Camera">
                    <Toggle />
                  </Subfield>
                  <Subfield name="Mirror Camera">
                    <Toggle />
                  </Subfield>
                  <div>
                    <Subfield name="Camera Position" class="mt-2" />
                    <div class="mt-3 rounded-lg border bg-gray-50 w-full h-24 relative">
                      <For
                        each={[
                          { x: "l", y: "t" } as const,
                          { x: "c", y: "t" } as const,
                          { x: "r", y: "t" } as const,
                          { x: "l", y: "b" } as const,
                          { x: "c", y: "b" } as const,
                          { x: "r", y: "b" } as const,
                        ]}
                      >
                        {(item) => (
                          <button
                            type="button"
                            data-selected={
                              state.camera.position.x === item.x &&
                              state.camera.position.y === item.y
                            }
                            class={cx(
                              "size-5 rounded-md bg-gray-300 absolute flex justify-center items-center data-[selected='true']:bg-blue-500 transition-colors duration-100",
                              item.x === "l"
                                ? "left-2"
                                : item.x === "r"
                                ? "right-2"
                                : "left-1/2 transform -translate-x-1/2",
                              item.y === "t" ? "top-2" : "bottom-2"
                            )}
                            onClick={() => setState("camera", "position", item)}
                          >
                            <div class="w-1/3 h-1/3 bg-white rounded-full" />
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </Field>
              <Field name="Rounded Corners" icon={<IconLucideCircleDashed />}>
                <Slider
                  value={[state.camera.rounding]}
                  onChange={(v) => setState("camera", "rounding", v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Shadow" icon={<IconTablerShadow />}>
                <Slider
                  value={[state.camera.shadow]}
                  onChange={(v) => setState("camera", "shadow", v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
            </Tabs.Content>
            <Tabs.Content
              value="transcript"
              class="p-3 flex flex-col gap-6 overflow-y-auto"
            >
              <Field name="Transcript" icon={<IconLucideMessageSquareMore />}>
                <div class="text-wrap bg-gray-50 border text-gray-400 p-1 rounded-md">
                  Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed
                  ac purus sit amet nunc ultrices ultricies. Nullam nec
                  scelerisque nunc. Nullam nec scelerisque nunc.
                </div>
                <button
                  type="button"
                  class="w-full bg-gray-400/20 hover:bg-gray-400/30 transition-colors duration-100 rounded-full py-1.5"
                >
                  Edit
                </button>
              </Field>
            </Tabs.Content>
            <Tabs.Content
              value="audio"
              class="p-3 flex flex-col gap-6 overflow-y-auto"
            >
              <Field name="Audio" icon={<IconLucideVolume1 />}>
                <div class="flex flex-col gap-3 ">
                  <Subfield name="Mute Audio">
                    <Toggle />
                  </Subfield>
                  <Subfield name="Improve Mic Quality">
                    <Toggle />
                  </Subfield>
                </div>
              </Field>
            </Tabs.Content>
            <Tabs.Content
              value="cursor"
              class="p-3 flex flex-col gap-6 overflow-y-auto"
            >
              <Field name="Cursor" icon={<IconLucideMousePointer2 />}>
                <Subfield name="Hide cursor when not moving">
                  <Toggle />
                </Subfield>
              </Field>
              <Field name="Size" icon={<IconMiExpand />}>
                <Slider
                  value={[state.cursor.size]}
                  onChange={(v) => setState("cursor", "size", v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Type" icon={<IconLucideMousePointer2 />}>
                <ul class="flex flex-row gap-2 text-gray-400">
                  <For
                    each={
                      [
                        { type: "pointer", icon: IconLucideMousePointer2 },
                        { type: "circle", icon: IconLucideCircle },
                      ] satisfies Array<{ icon: any; type: CursorType }>
                    }
                  >
                    {(item) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => setState("cursor", "type", item.type)}
                          data-selected={state.cursor.type === item.type}
                          class="border border-gray-200 bg-gray-100 rounded-lg size-12 data-[selected='true']:text-black"
                        >
                          <Dynamic
                            component={item.icon}
                            class="size-6 mx-auto"
                          />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Field>
            </Tabs.Content>
            <Tabs.Content
              value="hotkeys"
              class="p-3 flex flex-col gap-6 overflow-y-auto"
            >
              <Field name="Hotkeys" icon={<IconLucideCommand />}>
                <Subfield name="Show hotkeys">
                  <Toggle />
                </Subfield>
              </Field>
            </Tabs.Content>
          </Tabs>
        </div>
        <div class="px-6 py-8">
          <div class="h-14 border border-white ring-1 ring-blue-500 flex flex-row rounded-xl overflow-hidden -mx-3">
            <div class="bg-blue-500 w-3" />
            <div class="bg-blue-500/15 relative w-full h-full flex flex-row items-end justify-end">
              <span class="text-gray-400 text-sm pb-1 px-2">8:32</span>
            </div>
            <div class="bg-blue-500 w-3" />
          </div>
        </div>
      </div>
      <KDialog
        open={dialog().open}
        onOpenChange={(o) => {
          if (!o) setDialog((d) => ({ ...d, open: false }));
        }}
      >
        <KDialog.Portal>
          <KDialog.Overlay class="fixed inset-0 z-50 bg-black/50 ui-expanded:animate-in ui-expanded:fade-in ui-closed:animate-out ui-closed:fade-out" />
          <div class="fixed inset-0 z-50 flex items-center justify-center">
            <KDialog.Content class="z-50 divide-y text-sm rounded-2xl overflow-hidden max-w-96 border bg-white ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 origin-top ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95">
              <Show
                when={(() => {
                  const d = dialog();
                  if ("type" in d) return d;
                })()}
              >
                {(dialog) => (
                  <Switch>
                    <Match when={dialog().type === "createPreset"}>
                      <Dialog.Header title="Create Preset" />
                      <Dialog.Content>
                        <Subfield name="Name" required />
                        <Input />
                        <Subfield name="Set as default" class="mt-3">
                          <Toggle />
                        </Subfield>
                      </Dialog.Content>
                      <Dialog.Footer>
                        <Dialog.CloseButton />
                        <Dialog.ConfirmButton
                          onClick={() =>
                            setDialog((d) => ({ ...d, open: false }))
                          }
                        >
                          Create
                        </Dialog.ConfirmButton>
                      </Dialog.Footer>
                    </Match>
                    <Match
                      when={(() => {
                        const d = dialog();
                        if (d.type === "renamePreset") return d;
                      })()}
                    >
                      {(dialog) => (
                        <>
                          <Dialog.Header title="Rename Preset" />
                          <Dialog.Content>
                            <Subfield name="Name" required />
                            <Input value={dialog().presetId} />
                          </Dialog.Content>
                          <Dialog.Footer>
                            <Dialog.CloseButton />
                            <Dialog.ConfirmButton
                              onClick={() =>
                                setDialog((d) => ({ ...d, open: false }))
                              }
                            >
                              Rename
                            </Dialog.ConfirmButton>
                          </Dialog.Footer>
                        </>
                      )}
                    </Match>
                    <Match
                      when={(() => {
                        const d = dialog();
                        if (d.type === "deletePreset") return d;
                      })()}
                    >
                      {(_dialog) => (
                        <>
                          <Dialog.Header title="Delete Preset" />
                          <Dialog.Content>
                            <p class="text-gray-500">
                              Lorem ipsum dolor sit amet, consectetur adipiscing
                              elit sed do eiusmod tempor incididunt ut labore et
                              dolore magna aliqua.
                            </p>
                          </Dialog.Content>
                          <Dialog.Footer>
                            <Dialog.CloseButton />
                            <Dialog.ConfirmButton
                              variant="danger"
                              onClick={() =>
                                setDialog((d) => ({ ...d, open: false }))
                              }
                            >
                              Delete
                            </Dialog.ConfirmButton>
                          </Dialog.Footer>
                        </>
                      )}
                    </Match>
                  </Switch>
                )}
              </Show>
            </KDialog.Content>
          </div>
        </KDialog.Portal>
      </KDialog>
    </div>
  );
}

const actionButtonClasses =
  "flex flex-row items-center px-2 py-1.5 rounded-md gap-1.5 hover:bg-gray-100 ui-expanded:bg-gray-100 transition-colors duration-100 outline-none";
const popoverItemClasses =
  "flex flex-row gap-2 items-center data-[highlighted]:bg-gray-100 data-[highlighted]:text-black font-medium focus:outline-none rounded-md px-2.5 py-1.5 text-sm text-gray-400";
const popoverContentClasses =
  "focus:outline-none z-50 flex flex-col border bg-white overflow-y-hidden rounded-xl";
const popoverTopLeftAnimateClasses =
  "ui-expanded:animate-in ui-expanded:fade-in ui-expanded:zoom-in-95 ui-closed:animate-out ui-closed:fade-out ui-closed:zoom-out-95 origin-top-left";
const popoverListClasses = "p-1.5 outline-none flex flex-col gap-1";

function Field(props: ParentProps<{ name: string; icon: JSX.Element }>) {
  return (
    <div class="flex flex-col gap-3">
      <span class="flex flex-row items-center gap-2">
        {props.icon}
        {props.name}
      </span>
      {props.children}
    </div>
  );
}

function Subfield(
  props: ParentProps<{ name: string; class?: string; required?: boolean }>
) {
  return (
    <div
      class={cx(
        "flex flex-row justify-between items-center text-gray-400",
        props.class
      )}
    >
      <span class="font-medium">
        {props.name}
        {props.required && <span class="text-blue-500 ml-px">*</span>}
      </span>
      {props.children}
    </div>
  );
}

function Toggle(props: ComponentProps<typeof KSwitch>) {
  return (
    <KSwitch {...props}>
      <KSwitch.Input class="peer" />
      <KSwitch.Control class="rounded-full bg-gray-300 w-12 h-6 p-0.5 data-[checked]:bg-blue-500 transition-colors peer-focus-visible:outline outline-2 outline-offset-2 outline-blue-500">
        <KSwitch.Thumb class="bg-white rounded-full size-5 transition-transform data-[checked]:translate-x-[calc(100%+0.25rem)]" />
      </KSwitch.Control>
    </KSwitch>
  );
}

function Slider(props: ComponentProps<typeof KSlider>) {
  return (
    <KSlider
      {...props}
      class={cx("relative px-1 bg-gray-200 rounded-full", props.class)}
    >
      <KSlider.Track class="h-2 relative mx-1">
        <KSlider.Fill class="absolute bg-blue-400/50 h-full rounded-full -ml-2" />
        <KSlider.Thumb class="size-5 bg-blue-500 -top-1.5 rounded-full" />
      </KSlider.Track>
    </KSlider>
  );
}

function Input(props: ComponentProps<"input">) {
  return (
    <input
      {...props}
      class={cx(
        "rounded px-1 py-0.5 border-2 w-full mt-1 focus:border-blue-500 outline-none",
        props.class
      )}
    />
  );
}

const Dialog = {
  CloseButton() {
    return (
      <KDialog.CloseButton class="rounded-full bg-gray-200 text-black px-4 py-1.6 focus-visible:outline outline-2 outline-offset-2 outline-blue-500 hover:bg-gray-300 transition-colors duration-100">
        Cancel
      </KDialog.CloseButton>
    );
  },
  ConfirmButton(
    _props: Omit<ComponentProps<"button">, "type"> & {
      variant?: "primary" | "danger";
    }
  ) {
    const props = mergeProps({ variant: "primary" }, _props);
    return (
      <button
        {...props}
        type="button"
        class={cx(
          "px-4 py-1.5 rounded-full text-white font-normal focus-visible:outline outline-2 outline-offset-2 transition-colors duration-100",
          props.variant === "primary"
            ? "bg-blue-500 outline-blue-500 hover:bg-blue-600"
            : "bg-red-500 outline-red-500 hover:bg-red-600",
          props.class
        )}
      />
    );
  },
  Footer(props: ComponentProps<"div">) {
    return (
      <div
        class={cx(
          "px-4 py-3 flex flex-row justify-end gap-3 font-medium",
          props.class
        )}
        {...props}
      />
    );
  },
  Header(props: { title: string }) {
    return (
      <div class="px-4 py-4">
        <KDialog.Title class="font-semibold">{props.title}</KDialog.Title>
      </div>
    );
  },
  Content(props: ComponentProps<"div">) {
    return (
      <div
        class={cx("p-4 min-w-[22rem] flex flex-col", props.class)}
        {...props}
      />
    );
  },
};
