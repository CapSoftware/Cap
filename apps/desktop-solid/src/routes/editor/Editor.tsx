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
  type ParentProps,
  Show,
  Switch,
  createSignal,
} from "solid-js";
import { Dynamic } from "solid-js/web";

import {
  ASPECT_RATIOS,
  type AspectRatioName,
  type BackgroundSourceType,
  type CursorType,
  EditorContextProvider,
  useEditorContext,
} from "./context";
import {
  Dialog,
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
  return (
    <EditorContextProvider>
      <Inner />
    </EditorContextProvider>
  );
}

function Inner() {
  // const duation = 1.76;

  // const [playback, setPlayback] = createSignal({
  //   playing: false,
  //   time: 0,
  // });

  const [previewTime, setPreviewTime] = createSignal<number>(0);

  // let displayRef: HTMLVideoElement;

  // createEffect(() => {
  //   if (playback().playing) {
  //     displayRef.play();
  //   } else {
  //     displayRef.pause();
  //   }
  // });

  // createEffect(() => {
  //   if (playback().time !== displayRef.currentTime)
  //     displayRef.currentTime = playback().time;
  // });

  let timelineRef: HTMLDivElement;

  return (
    <div
      class="p-5 flex flex-col gap-4 w-screen h-screen divide-y bg-gray-50 rounded-lg"
      data-tauri-drag-region
    >
      <Header />
      <div class="rounded-2xl shadow border flex-1 flex flex-col divide-y bg-white">
        <div class="flex flex-row flex-1 divide-x overflow-y-hidden">
          <div class="flex flex-col divide-y flex-1">
            <div class="flex flex-row justify-between font-medium p-[0.75rem] text-[0.875rem]">
              <div class="flex flex-row items-center gap-[0.5rem]">
                <AspectRatioSelect />
                <EditorButton leftIcon={<IconLucideCrop />}>Crop</EditorButton>
                <PresetsDropdown />
              </div>
              <div class="flex flex-row place-items-center gap-2">
                <EditorButton leftIcon={<IconLucideUndo2 />}>Undo</EditorButton>
                <EditorButton
                  leftIcon={<IconLucideRedo2 class="text-gray-400" />}
                >
                  Redo
                </EditorButton>
              </div>
            </div>
            <div class="bg-gray-100 flex items-center justify-center flex-1 flex-row object-contain p-4">
              <div
                class="max-w-full max-h-full w-full bg-red-500"
                style={{ "aspect-ratio": 16 / 9 }}
              >
                {/*<video
                  ref={displayRef}
                  src={convertFileSrc(`${params.path}/content/display.mp4`)}
                />*/}
              </div>
            </div>
            <div class="flex flex-row items-center p-[0.75rem]">
              <div class="flex-1" />
              <div class="flex flex-row items-center justify-center gap-[0.5rem] text-gray-400 text-[0.875rem]">
                <span>0:00.00</span>
                <IconLucideRewind class="size-[1.2rem]" />
                <IconLucideCircleStop class="size-[1.5rem]" />
                <IconLucideFastForward class="size-[1rem]" />
                <span>8:32.16</span>
              </div>
              <div class="flex-1 flex flex-row justify-end">
                <EditorButton<typeof KToggleButton>
                  as={KToggleButton}
                  variant="danger"
                  leftIcon={<IconLucideScissors />}
                >
                  Split
                </EditorButton>
              </div>
            </div>
          </div>
          <SettingsSidebar />
        </div>
        <div class="px-6 py-8 relative">
          <div
            class="w-px bg-red-500 absolute left-0 top-3 bottom-0 z-10"
            style={{
              transform: `translateX(calc(1.5rem + ${previewTime()}rem))`,
            }}
          >
            <div class="size-2 bg-red-500 rounded-full -ml-1" />
          </div>
          <div class="relative h-14 border border-white ring-1 ring-blue-300 flex flex-row rounded-xl overflow-hidden -mx-3">
            <div class="bg-blue-300 w-[0.5rem]" />
            <div
              // biome-ignore lint/style/noNonNullAssertion: ref
              ref={timelineRef!}
              class="bg-blue-50 relative w-full h-full flex flex-row items-end justify-end px-[0.5rem] py-[0.25rem]"
              onMouseMove={(e) => {
                setPreviewTime(
                  (e.clientX - e.target.clientLeft) / e.target.clientWidth
                );
              }}
            >
              <span class="text-black-transparent-60 text-[0.625rem] font-[500]">
                0:00
              </span>
              <span class="text-black-transparent-60 text-[0.625rem] font-[500] ml-auto">
                8:32
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
  return (
    <header
      class="flex flex-row justify-between items-center"
      data-tauri-drag-region
    >
      <div class="flex flex-row items-center gap-[0.5rem] text-[0.875rem] font-[500]">
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
        <Button variant="primary" size="md">
          Save
        </Button>
      </div>
    </header>
  );
}

function ShareButton() {
  return (
    <button
      class="rounded-full h-[2rem] px-[1rem] flex flex-row items-center gap-[0.375rem] bg-gray-200 hover:bg-gray-300 transition-colors duration-100"
      type="button"
    >
      <span class="font-[500] text-[0.875rem] text-gray-500">
        cap.link/z2ha3dv61q5hrde
      </span>
    </button>
  );
}

const BACKGROUND_SOURCES = ["Wallpaper", "Image", "Color", "Gradient"];

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
            <KTabs.Trigger
              value={item.id}
              class="flex-1 text-gray-400 ui-selected:text-gray-500 z-10"
              onClick={() => setSelectedTab(item.id)}
            >
              <Dynamic class="mx-auto" component={item.icon} />
            </KTabs.Trigger>
          )}
        </For>
        <KTabs.Indicator class="absolute inset-0 transition-transform">
          <div class="bg-gray-100 w-full h-full" />
        </KTabs.Indicator>
      </KTabs.List>
      <div class="p-[0.75rem] overflow-y-auto text-[0.875rem] font-[500]">
        <KTabs.Content value="background" class="flex flex-col gap-[1.5rem]">
          <Field name="Background" icon={<IconLucideImage />}>
            <KTabs
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
              <KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
                <div class="absolute inset-0 flex flex-row items-center justify-evenly">
                  <For
                    each={Array.from(
                      { length: BACKGROUND_SOURCES.length - 1 },
                      (_, i) => i
                    )}
                  >
                    {(i) => (
                      <div
                        class={cx(
                          "w-px h-[0.75rem] rounded-full transition-colors",
                          BACKGROUND_SOURCES.indexOf(
                            state.background.source.type
                          ) === i ||
                            BACKGROUND_SOURCES.indexOf(
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
                <For each={BACKGROUND_SOURCES}>
                  {(item, i) => (
                    <KTabs.Trigger
                      class="flex-1 text-gray-400 py-1 z-10 ui-selected:text-gray-500 peer outline-none transition-colors duration-100"
                      value={item}
                    >
                      {item}
                    </KTabs.Trigger>
                  )}
                </For>
                <KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden">
                  <div class="bg-gray-100 flex-1" />
                </KTabs.Indicator>
              </KTabs.List>
              <KTabs.Content value="Wallpaper">
                <KRadioGroup
                  value={
                    state.background.source.type === "Wallpaper"
                      ? state.background.source.id.toString()
                      : undefined
                  }
                  onChange={(v) =>
                    setState("background", "source", {
                      type: "Wallpaper",
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
              <KTabs.Content value="Image">
                <button
                  type="button"
                  class="p-[0.75rem] bg-gray-100 w-full rounded-[0.5rem] border flex flex-col items-center justify-center gap-[0.5rem] text-gray-400"
                >
                  <IconLucideImage class="size-6" />
                  <span>Click to select or drag and drop image</span>
                </button>
              </KTabs.Content>
              <KTabs.Content
                value="Color"
                class="flex flex-row items-center gap-[0.75rem]"
              >
                <div
                  class="size-[3rem] rounded-[0.5rem]"
                  style={{ "background-color": "#4785FF" }}
                />
                <input
                  class="w-[5rem] p-[0.375rem] border text-gray-400 rounded-[0.5rem]"
                  value="#4785FF"
                />
              </KTabs.Content>
              <KTabs.Content
                value="Gradient"
                class="flex flex-row items-center gap-[1.5rem]"
              >
                <div class="flex flex-row items-center gap-[0.75rem]">
                  <div
                    class="size-[3rem] rounded-[0.5rem]"
                    style={{ "background-color": "#4785FF" }}
                  />
                  <input
                    class="w-[5rem] p-[0.375rem] border text-gray-400 rounded-[0.5rem]"
                    value="#4785FF"
                  />
                </div>
                <div class="flex flex-row items-center gap-[0.75rem]">
                  <div
                    class="size-[3rem] rounded-[0.5rem]"
                    style={{ "background-color": "#FF4766" }}
                  />
                  <input
                    class="w-[5rem] p-[0.375rem] border text-gray-400 rounded-[0.5rem]"
                    value="#FF4766"
                  />
                </div>
              </KTabs.Content>
            </KTabs>
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
        </KTabs.Content>
        <KTabs.Content value="camera" class="flex flex-col gap-[1.5rem]">
          <Field name="Camera" icon={<IconLucideVideo />}>
            <div class="flex flex-col gap-[0.75rem]">
              <Subfield name="Hide Camera">
                <Toggle />
              </Subfield>
              <Subfield name="Mirror Camera">
                <Toggle />
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
                      { x: "l", y: "t" } as const,
                      { x: "c", y: "t" } as const,
                      { x: "r", y: "t" } as const,
                      { x: "l", y: "b" } as const,
                      { x: "c", y: "b" } as const,
                      { x: "r", y: "b" } as const,
                    ]}
                  >
                    {(item) => (
                      <RadioGroup.Item value={`${item.x}:${item.y}`}>
                        <RadioGroup.ItemInput class="peer" />
                        <RadioGroup.ItemControl
                          class={cx(
                            "cursor-pointer size-[1.25rem] shink-0 rounded-[0.375rem] bg-gray-300 absolute flex justify-center items-center ui-checked:bg-blue-300 focus-visible:outline peer-focus-visible:outline outline-2 outline-offset-2 outline-blue-300 transition-colors duration-100",
                            item.x === "l"
                              ? "left-2"
                              : item.x === "r"
                              ? "right-2"
                              : "left-1/2 transform -translate-x-1/2",
                            item.y === "t" ? "top-2" : "bottom-2"
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
        </KTabs.Content>
        <KTabs.Content value="transcript" class="flex flex-col gap-6">
          <Field name="Transcript" icon={<IconLucideMessageSquareMore />}>
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
        </KTabs.Content>
        <KTabs.Content value="cursor" class="flex flex-col gap-6">
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
          <Field name="Hotkeys" icon={<IconLucideCommand />}>
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
    <KSelect<AspectRatioName | "Auto">
      value={state.aspectRatio}
      onChange={(v) => {
        if (v === null) return;
        setState("aspectRatio", v);
      }}
      defaultValue="Auto"
      options={["Auto", ...ASPECT_RATIOS.map((r) => r.name)]}
      multiple={false}
      itemComponent={(props) => {
        const item = () =>
          ASPECT_RATIOS.find((r) => r.name === props.item.rawValue);

        return (
          <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
            <KSelect.ItemLabel class="flex-1">
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
          </MenuItem>
        );
      }}
      placement="top-start"
    >
      <EditorButton<typeof KSelect.Trigger>
        as={KSelect.Trigger}
        leftIcon={<IconLucideLayoutDashboard />}
        rightIcon={
          <KSelect.Icon>
            <IconLucideChevronDown />
          </KSelect.Icon>
        }
      >
        <KSelect.Value>
          {(state) => <>{state.selectedOption()}</>}
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
        leftIcon={<IconLucideWandSparkles />}
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
                        <IconLucideSettings />
                      </button>
                    </MenuItem>
                    <KDropdownMenu.Portal>
                      {showSettings() && (
                        <MenuItemList<typeof KDropdownMenu.SubContent>
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
              <IconLucideCirclePlus class="ml-auto" />
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

function DialogContent(
  props: ParentProps<{ title: string; confirm: JSX.Element }>
) {
  return (
    <>
      <Dialog.Header title={props.title} />
      <Dialog.Content>{props.children}</Dialog.Content>
      <Dialog.Footer>{props.confirm}</Dialog.Footer>
    </>
  );
}
