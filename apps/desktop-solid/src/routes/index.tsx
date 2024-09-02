import { cx } from "cva";
import {
  For,
  Show,
  Suspense,
  type ValidComponent,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { Select as KSelect } from "@kobalte/core/select";
import { SwitchTab, Button } from "@cap/ui-solid";

import { createCameraForLabel, createCameras } from "../utils/media";
import { createOptionsQuery, createWindowsQuery } from "../utils/queries";
import { type CaptureWindow, commands, events } from "../utils/tauri";
import Header from "../components/Header";
import {
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
  MenuItem,
  topRightAnimateClasses,
} from "./editor/ui";
import { useNavigate } from "@solidjs/router";

export default function () {
  const cameras = createCameras();
  const options = createOptionsQuery();
  const windows = createWindowsQuery();

  const camera = createCameraForLabel(() => options.data?.cameraLabel ?? "");

  const [isRecording, setIsRecording] = createSignal(false);

  events.showCapturesPanel.listen(() => {
    commands.showPreviousRecordingsWindow();
  });

  commands.showPreviousRecordingsWindow();

  // const navigate = useNavigate();
  // navigate("/recording-permissions");

  return (
    <div class="rounded-[1.5rem] bg-gray-50 border border-gray-200 w-screen h-screen flex flex-col overflow-hidden">
      <Header />

      <Suspense
        fallback={
          <div class="w-full h-full flex items-center justify-center bg-gray-100">
            <div class="animate-spin">
              <IconCapLogo class="size-[4rem]" />
            </div>
          </div>
        }
      >
        <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400]">
          <Show when={options.data}>
            {(options) => {
              const [windowSelectOpen, setWindowSelectOpen] =
                createSignal(false);

              const selectedWindow = createMemo(() => {
                const d = options().captureTarget;
                if (d.type !== "window") return;
                return (windows.data ?? []).find((data) => data.id === d.id);
              });

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
                      if (
                        o === false &&
                        options().captureTarget.type === "screen"
                      )
                        return;
                      setWindowSelectOpen(o);
                    }}
                    itemComponent={(props) => (
                      <MenuItem<typeof KSelect.Item>
                        as={KSelect.Item}
                        item={props.item}
                      >
                        <KSelect.ItemLabel class="flex-1">
                          {props.item.rawValue?.name}
                        </KSelect.ItemLabel>
                      </MenuItem>
                    )}
                    value={selectedWindow() ?? null}
                    onChange={(d) => {
                      if (!d) return;
                      commands.setRecordingOptions({
                        ...options(),
                        captureTarget: { type: "window", id: d.id },
                      });
                      setWindowSelectOpen(false);
                    }}
                    placement="top-end"
                  >
                    <SwitchTab
                      value={options().captureTarget.type}
                      disabled={isRecording()}
                      onChange={(s) => {
                        console.log({ s });
                        if (options().captureTarget.type === s) return;
                        if (s === "screen")
                          commands.setRecordingOptions({
                            ...options(),
                            captureTarget: { type: "screen" },
                          });
                        else if (s === "window") setWindowSelectOpen(true);
                      }}
                    >
                      <SwitchTab.List>
                        <SwitchTab.Trigger value="screen">
                          Screen
                        </SwitchTab.Trigger>
                        <SwitchTab.Trigger<ValidComponent>
                          as={(p) => <KSelect.Trigger<ValidComponent> {...p} />}
                          value="window"
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
                      placeholder="No Camera"
                      value={camera()}
                      disabled={isRecording()}
                      onChange={(d) => {
                        if (!d) return;
                        commands.setRecordingOptions({
                          ...options(),
                          cameraLabel: d.label,
                        });
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
                      <KSelect.Trigger class="h-[2rem] px-[0.375rem] flex flex-row gap-[0.375rem] border rounded-lg border-gray-200 w-full items-center disabled:text-gray-400 transition-colors">
                        <IconCapCamera class="text-gray-400 size-[1.25rem]" />
                        <KSelect.Value<MediaDeviceInfo> class="flex-1 text-left truncate">
                          {(state) => <>{state.selectedOption().label}</>}
                        </KSelect.Value>
                        <button
                          type="button"
                          class={cx(
                            "px-[0.375rem] rounded-full text-[0.75rem]",
                            camera()
                              ? "bg-blue-50 text-blue-300"
                              : "bg-red-50 text-red-300"
                          )}
                          onPointerDown={(e) => {
                            if (!camera()) return;
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                          onClick={(e) => {
                            if (!camera()) return;
                            e.stopPropagation();
                            e.preventDefault();

                            commands.setRecordingOptions({
                              ...options(),
                              cameraLabel: null,
                            });
                          }}
                        >
                          {camera() ? "On" : "Off"}
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
                      disabled={isRecording()}
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
                      <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors">
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
                          class={cx(
                            "px-[0.375rem] rounded-full text-[0.75rem]",
                            false
                              ? "bg-blue-50 text-blue-300"
                              : "bg-red-50 text-red-300"
                          )}
                          onPointerDown={(e) => {
                            if (!camera()) return;
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                          onClick={(e) => {
                            if (!camera()) return;
                            e.stopPropagation();
                            e.preventDefault();

                            commands.setRecordingOptions({
                              ...options(),
                              cameraLabel: null,
                            });
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
                    variant={isRecording() ? "destructive" : "primary"}
                    size="md"
                    onClick={() => {
                      if (!isRecording())
                        commands
                          .startRecording()
                          .then(() => setIsRecording(true));
                      else
                        commands
                          .stopRecording()
                          .then(() => setIsRecording(false));
                    }}
                  >
                    {isRecording() ? "Stop Recording" : "Start Recording"}
                  </Button>
                  <button type="button" class="text-gray-400 text-[0.875rem]">
                    Open Cap on Web
                  </button>
                </>
              );
            }}
          </Show>
        </div>
      </Suspense>
    </div>
  );
}
