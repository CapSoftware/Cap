import { cx } from "cva";
import {
  For,
  Show,
  Suspense,
  ValidComponent,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { Select as KSelect } from "@kobalte/core/select";
import { SwitchTab } from "@cap/ui-solid";

import { createCameraForLabel, createCameras } from "../utils/media";
import { createOptionsQuery, createWindowsQuery } from "../utils/queries";
import { CaptureWindow, commands, events } from "../utils/tauri";
import Header from "../components/Header";

import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import {
  EditorButton,
  MenuItemList,
  PopperContent,
  DropdownItem,
  topLeftAnimateClasses,
  MenuItem,
  topRightAnimateClasses,
} from "./editor/ui";
import { Button } from "@cap/ui-solid";

export default function () {
  const cameras = createCameras();
  const options = createOptionsQuery();
  const windows = createWindowsQuery();

  const camera = createCameraForLabel(() => options.data?.cameraLabel ?? "");

  // temporary
  const [isRecording, setIsRecording] = createSignal(false);

  events.showCapturesPanel.listen(() => {
    commands.showPreviousRecordingsWindow();
  });

  commands.showPreviousRecordingsWindow();

  const [display, setDisplay] = createSignal<
    { type: "Screen" } | { type: "Window"; window: number }
  >({ type: "Screen" });

  createEffect(() => console.log(display()));
  const selectedWindow = createMemo(() => {
    const d = display();
    if (d.type !== "Window") return;
    return (windows.data ?? []).find((data) => data.id === d.window);
  });

  return (
    <div class="rounded-[1.5rem]">
      <Header />
      <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400]">
        <Suspense fallback="LOADING">
          <Show when={options.data}>
            {(options) => {
              const [windowSelectOpen, setWindowSelectOpen] =
                createSignal(false);

              return (
                <>
                  <KSelect<CaptureWindow | null>
                    options={windows.data ?? []}
                    optionValue="id"
                    optionTextValue="name"
                    placeholder="Window"
                    gutter={8}
                    open={windowSelectOpen()}
                    onOpenChange={(o) => {
                      // prevents tab onChange from interfering with dropdown trigger click
                      if (o === false && display().type === "Screen") return;
                      setWindowSelectOpen(o);
                    }}
                    itemComponent={(props) => (
                      <MenuItem<typeof KSelect.Item>
                        as={KSelect.Item}
                        item={props.item}
                      >
                        <KSelect.ItemLabel class="flex-1">
                          {props.item.rawValue.name}
                        </KSelect.ItemLabel>
                      </MenuItem>
                    )}
                    value={selectedWindow() ?? null}
                    onChange={(d) => {
                      if (!d) return;
                      setDisplay({ type: "Window", window: d.id });
                    }}
                    placement="top-end"
                  >
                    <SwitchTab
                      value={display().type}
                      onChange={(s) => {
                        if (display().type === s) return;
                        if (s === "Screen") setDisplay({ type: "Screen" });
                        else if (s === "Window") setWindowSelectOpen(true);
                      }}
                    >
                      <SwitchTab.List>
                        <SwitchTab.Trigger value="Screen">
                          Screen
                        </SwitchTab.Trigger>
                        <SwitchTab.Trigger<ValidComponent>
                          as={(p) => <KSelect.Trigger<ValidComponent> {...p} />}
                          value="Window"
                          class="w-full text-nowrap overflow-hidden px-2 group"
                        >
                          <KSelect.Value<CaptureWindow> class="flex flex-row items-center justify-center">
                            {(item) => (
                              <>
                                <span class="flex-1 truncate">
                                  {item.selectedOption().name}
                                </span>

                                <IconCapChevronDown class="size-4 shrink-0 ui-group-expanded:-rotate-180 transform transition-transform" />
                              </>
                            )}
                          </KSelect.Value>
                        </SwitchTab.Trigger>
                      </SwitchTab.List>
                    </SwitchTab>
                    <KSelect.Portal>
                      <PopperContent<typeof KSelect.Content>
                        as={KSelect.Content}
                        class={topRightAnimateClasses}
                      >
                        <KSelect.Listbox
                          class="max-h-52 max-w-64"
                          as={MenuItemList}
                        />
                      </PopperContent>
                    </KSelect.Portal>
                  </KSelect>
                  <div class="flex flex-col gap-[0.25rem] items-stretch">
                    <label class="text-gray-400 text-[0.875rem]">Camera</label>
                    <KSelect<MediaDeviceInfo>
                      options={cameras()}
                      optionValue="deviceId"
                      optionTextValue="label"
                      value={cameras()[0]}
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
                      <KSelect.Trigger class="h-[2rem] px-[0.375rem] flex flex-row gap-[0.375rem] border rounded-lg border-gray-200 w-full items-center">
                        <IconCapCamera class="text-gray-400 size-[1.25rem]" />
                        <KSelect.Value<MediaDeviceInfo> class="flex-1 text-left">
                          {(state) => <>{state.selectedOption().label}</>}
                        </KSelect.Value>
                        <button
                          type="button"
                          class="px-[0.375rem] bg-blue-50 text-blue-300 rounded-full text-[0.75rem]"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                        >
                          On
                        </button>
                      </KSelect.Trigger>
                      <KSelect.Portal>
                        <PopperContent<typeof KSelect.Content>
                          as={KSelect.Content}
                          class={topLeftAnimateClasses}
                        >
                          <MenuItemList<typeof KSelect.Listbox>
                            as={KSelect.Listbox}
                          />
                        </PopperContent>
                      </KSelect.Portal>
                    </KSelect>
                  </div>
                  <div class="flex flex-col gap-[0.25rem] items-stretch">
                    <label class="text-gray-400">Microphone</label>
                    <KSelect<MediaDeviceInfo>
                      options={cameras()}
                      optionValue="deviceId"
                      optionTextValue="label"
                      placeholder="No Audio"
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
                      <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full">
                        <IconCapMicrophone class="text-gray-400 size-[1.25rem]" />
                        <KSelect.Value<MediaDeviceInfo> class="flex-1 text-left">
                          {(state) => (
                            <>
                              No Audio
                              {/* {state.selectedOption().label} */}
                            </>
                          )}
                        </KSelect.Value>
                        <button
                          type="button"
                          class="px-[0.375rem] bg-red-50 text-red-300 rounded-full text-[0.75rem]"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                        >
                          Off
                        </button>

                        {false && (
                          <button
                            type="button"
                            class="px-[0.375rem] bg-blue-50 text-blue-300 rounded-full text-[0.75rem]"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                            }}
                          >
                            On
                          </button>
                        )}
                      </KSelect.Trigger>
                      <KSelect.Portal>
                        <PopperContent<typeof KSelect.Content>
                          as={KSelect.Content}
                          class={topLeftAnimateClasses}
                        >
                          <MenuItemList<typeof KSelect.Listbox>
                            as={KSelect.Listbox}
                          />
                        </PopperContent>
                      </KSelect.Portal>
                    </KSelect>
                  </div>
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() =>
                      commands.startRecording().then(() => setIsRecording(true))
                    }
                  >
                    Start Recording
                  </Button>
                  <button type="button" class="text-gray-400 text-[0.875rem]">
                    Open Cap on Web
                  </button>
                </>
              );
            }}
          </Show>
        </Suspense>
      </div>
    </div>
  );
}
