import { useSearchParams } from "@solidjs/router";
import {
  type ComponentProps,
  createSignal,
  For,
  type JSX,
  type ParentProps,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { Tabs } from "@kobalte/core/tabs";
import { Slider as KSlider } from "@kobalte/core/slider";
import { Switch as KSwitch } from "@kobalte/core/switch";
import { cx } from "cva";

export default function () {
  const [params] = useSearchParams<{ path: string }>();

  const [selectedTab, setSelectedTab] = createSignal<
    "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
  >("camera");

  const [backgroundBlur, setBackgroundBlur] = createSignal(20);
  const [cameraPosition, setCameraPosition] = createSignal<{
    x: "l" | "c" | "r";
    y: "t" | "b";
  }>({ x: "r", y: "b" });
  const [selectedPointer, setSelectedPointer] = createSignal<
    "point" | "circle"
  >("point");
  const [backgroundSource, setBackgroundSource] = createSignal<
    "Wallpaper" | "Image" | "Color" | "Gradient"
  >("Wallpaper");

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
            <div class="flex flex-row h-14 justify-between font-medium px-3">
              <div class="flex flex-row items-center gap-2">
                <button
                  type="button"
                  class="flex flex-row items-center p-1 rounded-md gap-1.5"
                >
                  <IconLucideLayoutDashboard class="text-black/50" />
                  Auto
                  <IconLucideChevronDown />
                </button>
                <button
                  type="button"
                  class="flex flex-row items-center p-1 rounded-md gap-1.5"
                >
                  <IconLucideCrop class="text-black/50" />
                  Crop
                </button>
                <button
                  type="button"
                  class="flex flex-row items-center p-1 rounded-md gap-1.5"
                >
                  <IconLucideWandSparkles class="text-black/50" />
                  Presets
                </button>
              </div>
              <div class="flex flex-row place-items-center gap-2">
                <button
                  type="button"
                  class="flex flex-row items-center p-1 rounded-md gap-1.5"
                >
                  <IconLucideUndo2 class="text-black/50" />
                  Undo
                </button>
                <button
                  type="button"
                  class="flex flex-row items-center p-1 rounded-md gap-1.5"
                >
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
                  value={backgroundSource()}
                  onChange={(v) => setBackgroundSource(v as any)}
                >
                  <Tabs.List class="border flex flex-row rounded-lg relative overflow-hidden">
                    <For each={["Wallpaper", "Image", "Color", "Gradient"]}>
                      {(item) => (
                        <Tabs.Trigger
                          class="flex-1 text-gray-500 py-1 z-10 data-[highlighted]:text-black"
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
                        {(_) => (
                          <div class="border border-gray-200 bg-gray-100 rounded-lg col-span-1 row-span-1" />
                        )}
                      </For>
                    </div>
                  </Tabs.Content>
                  <Tabs.Content value="Image">
                    <button
                      type="button"
                      class="h-20 bg-gray-50 w-full rounded-md border flex flex-col items-center justify-center gap-2 text-gray-500"
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
                      class="border p-1 text-gray-500 w-20 rounded-md"
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
                      class="border p-1 text-gray-500 w-20 rounded-md"
                      value="#4785FF"
                    />
                    <br />
                    <div
                      class="size-12 rounded-md"
                      style={{ "background-color": "#FF4766" }}
                    />
                    <input
                      class="border p-1 text-gray-500 w-20 rounded-md"
                      value="#FF4766"
                    />
                  </Tabs.Content>
                </Tabs>
              </Field>
              <Field name="Background Blur" icon={<IconMdiBlur />}>
                <Slider
                  value={[backgroundBlur()]}
                  onChange={(v) => setBackgroundBlur(v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Padding" icon={<IconHugeiconsDashedLine02 />}>
                <Slider
                  value={[backgroundBlur()]}
                  onChange={(v) => setBackgroundBlur(v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Rounded Corners" icon={<IconLucideCircleDashed />}>
                <Slider
                  value={[backgroundBlur()]}
                  onChange={(v) => setBackgroundBlur(v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Inset" icon={<IconLucideSquare />}>
                <Slider
                  value={[backgroundBlur()]}
                  onChange={(v) => setBackgroundBlur(v[0])}
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
                              cameraPosition().x === item.x &&
                              cameraPosition().y === item.y
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
                            onClick={() => setCameraPosition(item)}
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
                  value={[backgroundBlur()]}
                  onChange={(v) => setBackgroundBlur(v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Shadow" icon={<IconTablerShadow />}>
                <Slider
                  value={[backgroundBlur()]}
                  onChange={(v) => setBackgroundBlur(v[0])}
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
                  value={[backgroundBlur()]}
                  onChange={(v) => setBackgroundBlur(v[0])}
                  minValue={0}
                  maxValue={100}
                />
              </Field>
              <Field name="Type" icon={<IconLucideMousePointer2 />}>
                <ul class="flex flex-row gap-2 text-gray-400">
                  <For
                    each={
                      [
                        { id: "point", icon: IconLucideMousePointer2 },
                        { id: "circle", icon: IconLucideCircle },
                      ] as const
                    }
                  >
                    {(item) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => setSelectedPointer(item.id)}
                          data-selected={selectedPointer() === item.id}
                          class="border border-gray-200 bg-gray-100 rounded-lg size-12 data-[selected='true']:text-black transition-colors duration-100"
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
              <span class="text-gray-500 text-sm pb-1 px-2">8:32</span>
            </div>
            <div class="bg-blue-500 w-3" />
          </div>
        </div>
      </div>
    </div>
  );
}

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

function Subfield(props: ParentProps<{ name: string; class?: string }>) {
  return (
    <div class={cx("flex flex-row justify-between text-gray-400", props.class)}>
      <span>{props.name}</span>
      {props.children}
    </div>
  );
}

function Toggle(props: ComponentProps<typeof KSwitch>) {
  return (
    <KSwitch {...props}>
      <KSwitch.Input />
      <KSwitch.Control class="rounded-full bg-gray-300 w-12 h-6 p-0.5 data-[checked]:bg-blue-500 transition-colors">
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
