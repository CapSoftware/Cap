import { Button, SwitchTab } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { cache, createAsync, redirect, useNavigate } from "@solidjs/router";
import { createMutation, createQuery } from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import { cx } from "cva";
import {
  Show,
  type ValidComponent,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onMount,
} from "solid-js";
import { createStore } from "solid-js/store";

import { authStore } from "~/store";
import { clientEnv } from "~/utils/env";
import {
  createCurrentRecordingQuery,
  createOptionsQuery,
  listWindows,
  listAudioDevices,
  getPermissions,
  createVideoDevicesQuery,
  listScreens,
} from "~/utils/queries";
import { CaptureScreen, type CaptureWindow, commands, events } from "~/utils/tauri";
import {
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
  topRightAnimateClasses,
} from "../editor/ui";

const getAuth = cache(async () => {
  const value = await authStore.get();
  if (!value) return redirect("/signin");
  return value;
}, "getAuth");

export const route = {
  load: () => getAuth(),
};

export default function () {
  const options = createOptionsQuery();
  const screens = createQuery(() => listScreens);
  const windows = createQuery(() => listWindows);
  const videoDevices = createVideoDevicesQuery();
  const audioDevices = createQuery(() => listAudioDevices);
  const currentRecording = createCurrentRecordingQuery();

  const [windowSelectOpen, setWindowSelectOpen] = createSignal(false);
  const [screenSelectOpen, setScreenSelectOpen] = createSignal(false);
  const [selectedTarget, setSelectedTarget] = createSignal<CaptureScreen | CaptureWindow | null>();
  
  const screenLabel = createMemo(() => options.data?.captureTarget?.type === "screen" && selectedTarget()?.name ? selectedTarget()?.name : "Screen");
  const windowLabel = createMemo(() => options.data?.captureTarget?.type === "window" && selectedTarget()?.name ? selectedTarget()?.name : "Window")

  const permissions = createQuery(() => getPermissions);

  const [microphoneSelectOpen, setMicrophoneSelectOpen] = createSignal(false);

  events.showCapturesPanel.listen(() => {
    commands.showPreviousRecordingsWindow();
  });

  onMount(() => {
    commands.showPreviousRecordingsWindow();
  });

  const isRecording = () => !!currentRecording.data;

  const toggleRecording = createMutation(() => ({
    mutationFn: async () => {
      if (!isRecording()) {
        await commands.startRecording();
      } else {
        await commands.stopRecording();
      }
    },
  }));

  // important for sign in redirect, trust me
  createAsync(() => getAuth());

  createUpdateCheck();

  const [changelogState, setChangelogState] = makePersisted(
    createStore({
      hasUpdate: false,
      lastOpenedVersion: "",
      changelogClicked: false,
    }),
    { name: "changelogState" }
  );

  const [currentVersion] = createResource(() => getVersion());

  const [changelogStatus] = createResource(
    () => currentVersion(),
    async (version) => {
      if (!version) {
        return { hasUpdate: false };
      }
      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/changelog/status?version=${version}`
      );
      return await response.json();
    }
  );

  createEffect(() => {
    if (changelogStatus.state === "ready" && currentVersion()) {
      const hasUpdate = changelogStatus()?.hasUpdate || false;
      if (
        hasUpdate === true &&
        changelogState.lastOpenedVersion !== currentVersion()
      ) {
        setChangelogState({
          hasUpdate: true,
          lastOpenedVersion: currentVersion(),
          changelogClicked: false,
        });
      }
    }
  });

  const handleChangelogClick = () => {
    commands.openChangelogWindow();
    const version = currentVersion();
    if (version) {
      setChangelogState({
        hasUpdate: false,
        lastOpenedVersion: version,
        changelogClicked: true,
      });
    }
  };

  const selectedScreen = () => {
    const d = options.data?.captureTarget;
    if (d?.type !== "screen") return 
    return screens.data?.find((data) => data.id === d.id);
  };

  const selectedWindow = () => {
    const d = options.data?.captureTarget;
    if (d?.type !== "window") return 
    return windows.data?.find((data) => data.id === d.id);
  };

  const audioDevice = () =>
    audioDevices?.data?.find(
      (d) => d.name === options.data?.audioInputName
    ) ?? { name: "No Audio", deviceId: "" };

  const requestPermission = async (type: "camera" | "microphone") => {
    try {
      if (type === "camera") {
        await commands.resetCameraPermissions();
      } else if (type === "microphone") {
        await commands.resetMicrophonePermissions();
      }
      await commands.requestPermission(type);
      // Refresh permissions after request
      await permissions.refetch();
    } catch (error) {
      console.error(`Failed to get ${type} permission:`, error);
    }
  };

  const handleMicrophoneChange = async (
    item: { name: string; deviceId: string } | null
  ) => {
    if (!item && permissions?.data?.microphone !== "granted") {
      return requestPermission("microphone");
    }

    if (!item || !options.data) return;

    commands.setRecordingOptions({
      ...options.data,
      audioInputName: item.name !== "No Audio" ? item.name : null,
    });
  };

  return (
    <div class="flex justify-center flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] bg-gray-50 h-full">
      <div class="absolute top-3 right-3">
        <div class="flex items-center gap-[0.25rem]">
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              commands.openFeedbackWindow();
            }}
          >
            Feedback
          </Button>
          <div>
            <button
              type="button"
              onClick={handleChangelogClick}
              class="relative"
            >
              <IconLucideBell class="w-[1.15rem] h-[1.15rem] text-gray-400 hover:text-gray-500" />
              {changelogState.hasUpdate && (
                <div
                  style={{ "background-color": "#FF4747" }}
                  class="block z-10 absolute top-0 right-0 w-2 h-2 rounded-full animate-bounce"
                />
              )}
            </button>
          </div>
        </div>
      </div>
      <div class="flex items-center justify-between pb-[0.25rem]">
        <IconCapLogoFull class="w-[90px] h-auto" />
        <button
          type="button"
          onClick={() => commands.openSettingsWindow("general")}
        >
          <IconCapSettings class="w-[1.25rem] h-[1.25rem] text-gray-400 hover:text-gray-500" />
        </button>
      </div>
      <KSelect<CaptureWindow | null>
        options={(screenSelectOpen() ? screens.data : windows.data) ?? []}
        optionValue="id"
        optionTextValue="name"
        gutter={8}
        open={screenSelectOpen() || windowSelectOpen()}
        itemComponent={(props: { item: any }) => {
          return (
          <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item} 
            onClick={() => {
              setSelectedTarget(props.item.rawValue)
              setScreenSelectOpen(false);
              setWindowSelectOpen(false)
            }}
          >
            	<KSelect.ItemLabel class="flex-1">
              	{props.item.rawValue?.name}
            	</KSelect.ItemLabel>
          	</MenuItem>
        	)}
        }
        value={selectedTarget() ?? null}
        placement="top-end"
      >
        <SwitchTab
          value={options.data?.captureTarget.type}
          disabled={isRecording()}
          onChange={(s) => {
            if (!options.data) return;

            setScreenSelectOpen(s === "screen");
            setWindowSelectOpen(s === "window");
          }}
        >
          <SwitchTab.List>
            <SwitchTab.Trigger<ValidComponent>
              as={(p) => <KSelect.Trigger<ValidComponent> {...p} />}
              value="screen"
              id="screen"
              class="w-full text-nowrap overflow-hidden px-2 flex gap-2 items-center justify-center"
              onClick={() => {
                const id = selectedTarget()?.id
                if (!id || !options.data) return;

                if (options.data.captureTarget.type !== "screen") {
                  setSelectedTarget(null)
                }

                commands.setRecordingOptions({
                  ...options.data,
                  captureTarget: { type: "screen", id },
                });

              }}
            >
              {screenLabel()}
              <IconCapChevronDown class={`size-4 shrink-0 transform transition-transform ${screenSelectOpen() && "-rotate-180"}`} />
            </SwitchTab.Trigger>
            <SwitchTab.Trigger<ValidComponent>
              as={(p) => <KSelect.Trigger<ValidComponent> {...p} />}
              value="window"
              id="window"
              class="w-full text-nowrap overflow-hidden px-2 group flex gap-2 items-center justify-center"
              onClick={() => {
                const id = selectedTarget()?.id
                if (!id || !options.data) return;

                if (options.data.captureTarget.type !== "window") {
                  setSelectedTarget(null)
                }

                commands.setRecordingOptions({
                  ...options.data,
                  captureTarget: { type: "window", id },
                });

              }}
            >
              {windowLabel()}
              <IconCapChevronDown  class={`size-4 shrink-0 transform transition-transform ${windowSelectOpen() && "-rotate-180"}`}  />
            </SwitchTab.Trigger>
          </SwitchTab.List>
        </SwitchTab>
        <KSelect.Portal>
          {screenSelectOpen() && (
            <PopperContent<typeof KSelect.Content>
              as={KSelect.Content}
              class={topRightAnimateClasses}
              onPointerDownOutside={() => {
                setScreenSelectOpen(false);
            }}
            >
              <Show
                when={(screens.data ?? []).length > 0}
                fallback={
                  <div class="p-2 text-gray-500">No screens available</div>
                }
              >
                <KSelect.Listbox class="max-h-52 max-w-64" as={MenuItemList} />
              </Show>
            </PopperContent>
          )}
          {windowSelectOpen() && ( 
            <PopperContent<typeof KSelect.Content>
              as={KSelect.Content}
              class={topRightAnimateClasses}
              onPointerDownOutside={() => {
                  setWindowSelectOpen(false);
              }}
            >
              <Show
                when={(windows.data ?? []).length > 0}
                fallback={
                  <div class="p-2 text-gray-500">No windows available</div>
                }
              >
                <KSelect.Listbox class="max-h-52 max-w-64" as={MenuItemList} />
              </Show>
            </PopperContent>
          )}
        </KSelect.Portal>
      </KSelect>
      <div class="flex flex-col gap-[0.25rem] items-stretch">
        <label class="text-gray-400 text-[0.875rem]">Camera</label>
        <Show when>
          {(_) => {
            type Option = { isCamera: boolean; name: string };

            const onChange = async (item: Option | null) => {
              if (!item && permissions?.data?.camera !== "granted") {
                return requestPermission("camera");
              }

              if (!options.data) return;

              if (!item || !item.isCamera) {
                await commands.setRecordingOptions({
                  ...options.data,
                  cameraLabel: null,
                });
              } else {
                await commands.setRecordingOptions({
                  ...options.data,
                  cameraLabel: item.name,
                });
              }
            };
            const selectOptions = createMemo(() => [
              { name: "No Camera", isCamera: false },
              ...videoDevices.map((d) => ({ isCamera: true, name: d })),
            ]);

            const value = () =>
              selectOptions()?.find(
                (o) => o.name === options.data?.cameraLabel
              ) ?? null;

            return (
              <KSelect<Option>
                options={selectOptions()}
                optionValue="name"
                optionTextValue="name"
                placeholder="No Camera"
                value={value()}
                disabled={isRecording()}
                onChange={onChange}
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
              >
                <KSelect.Trigger
                  class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect"
                  onClick={(e) => {
                    if (permissions?.data?.camera !== "granted") {
                      requestPermission("camera");
                    }
                  }}
                >
                  <IconCapCamera class="text-gray-400 size-[1.25rem]" />
                  <KSelect.Value<Option> class="flex-1 text-left truncate">
                    {(state) => <span>{state.selectedOption().name}</span>}
                  </KSelect.Value>
                  <button
                    type="button"
                    class={cx(
                      "px-[0.375rem] rounded-full text-[0.75rem]",
                      options.data?.cameraLabel
                        ? "bg-blue-50 text-blue-300"
                        : "bg-red-50 text-red-300"
                    )}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (permissions?.data?.camera !== "granted") {
                        console.log("requesting permission");
                        return requestPermission("camera");
                      }
                      if (!options.data?.cameraLabel) return;
                      commands.setRecordingOptions({
                        ...options.data,
                        cameraLabel: null,
                      });
                    }}
                  >
                    {permissions?.data?.camera !== "granted"
                      ? "Request Permission"
                      : options.data?.cameraLabel
                      ? "On"
                      : "Off"}
                  </button>
                </KSelect.Trigger>
                <KSelect.Portal>
                  <PopperContent<typeof KSelect.Content>
                    as={KSelect.Content}
                    class={topLeftAnimateClasses}
                  >
                    <MenuItemList<typeof KSelect.Listbox>
                      class="max-h-36 overflow-y-auto"
                      as={KSelect.Listbox}
                    />
                  </PopperContent>
                </KSelect.Portal>
              </KSelect>
            );
          }}
        </Show>
      </div>
      <div class="flex flex-col gap-[0.25rem] items-stretch">
        <label class="text-gray-400">Microphone</label>
        <KSelect<{ name: string; deviceId: string }>
          options={[
            { name: "No Audio", deviceId: "" },
            ...(audioDevices.data ?? []),
          ]}
          optionValue="deviceId"
          optionTextValue="name"
          placeholder="No Audio"
          value={audioDevice()}
          disabled={isRecording()}
          onChange={handleMicrophoneChange}
          itemComponent={(props) => (
            <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
              <KSelect.ItemLabel class="flex-1">
                {props.item.rawValue.name}
              </KSelect.ItemLabel>
            </MenuItem>
          )}
          open={microphoneSelectOpen()}
          onOpenChange={async (isOpen: boolean) => {
            if (isOpen) {
              if (audioDevice().name === "No Audio") {
                setMicrophoneSelectOpen(false);
                await audioDevices.refetch();
              }
              setMicrophoneSelectOpen(true);
            } else {
              setMicrophoneSelectOpen(false);
            }
          }}
        >
          <KSelect.Trigger
            class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect"
            onClick={(e) => {
              if (permissions?.data?.microphone !== "granted") {
                requestPermission("microphone");
              }
            }}
          >
            <IconCapMicrophone class="text-gray-400 size-[1.25rem]" />
            <KSelect.Value<{
              name: string;
            }> class="flex-1 text-left truncate">
              {(state) => (
                <span>{state.selectedOption()?.name ?? "No Audio"}</span>
              )}
            </KSelect.Value>
            <button
              type="button"
              class={cx(
                "px-[0.375rem] rounded-full text-[0.75rem]",
                options.data?.audioInputName
                  ? "bg-blue-50 text-blue-300"
                  : "bg-red-50 text-red-300"
              )}
              onClick={async (e) => {
                e.stopPropagation();
                if (permissions?.data?.microphone !== "granted") {
                  await requestPermission("microphone");
                  if (permissions?.data?.microphone === "granted") {
                    commands.setRecordingOptions({
                      ...options.data,
                      audioInputName: audioDevice().name,
                    });
                  }
                } else {
                  if (!options.data?.audioInputName) return;
                  commands.setRecordingOptions({
                    ...options.data,
                    audioInputName: null,
                  });
                }
              }}
            >
              {permissions?.data?.microphone !== "granted"
                ? "Request Permission"
                : options.data?.audioInputName
                ? "On"
                : "Off"}
            </button>
          </KSelect.Trigger>
          <KSelect.Portal>
            <PopperContent<typeof KSelect.Content>
              as={KSelect.Content}
              class={topLeftAnimateClasses}
            >
              <MenuItemList<typeof KSelect.Listbox>
                class="max-h-36 overflow-y-auto"
                as={KSelect.Listbox}
              />
            </PopperContent>
          </KSelect.Portal>
        </KSelect>
      </div>
      <div class="w-full flex items-center space-x-1">
        <Button
          disabled={toggleRecording.isPending}
          variant={isRecording() ? "destructive" : "primary"}
          size="md"
          onClick={() => toggleRecording.mutate()}
          class="flex-grow"
        >
          {isRecording() ? "Stop Recording" : "Start Recording"}
        </Button>
        <Button
          disabled={isRecording()}
          variant="secondary"
          size="md"
          onClick={() => commands.takeScreenshot()}
        >
          <IconLucideCamera class="w-[1rem] h-[1rem]" />
        </Button>
      </div>
      <a
        href={`${import.meta.env.VITE_SERVER_URL}/dashboard`}
        target="_blank"
        rel="noreferrer"
        class="text-gray-400 text-[0.875rem] mx-auto hover:text-gray-500 hover:underline"
      >
        Open Cap on Web
      </a>
    </div>
  );
}

import * as dialog from "@tauri-apps/plugin-dialog";
import * as updater from "@tauri-apps/plugin-updater";
import { makePersisted } from "@solid-primitives/storage";

let hasChecked = false;
function createUpdateCheck() {
  if (import.meta.env.DEV) return;

  const navigate = useNavigate();

  onMount(async () => {
    if (hasChecked) return;
    hasChecked = true;

    await new Promise((res) => setTimeout(res, 1000));

    const update = await updater.check();
    if (!update) return;

    const shouldUpdate = await dialog.confirm(
      `Version ${update.version} of Cap is available, would you like to install it?`,
      { title: "Update Cap", okLabel: "Update", cancelLabel: "Ignore" }
    );

    if (!shouldUpdate) return;
    navigate("/update");
  });
}

function dbg<T>(v: T) {
  console.log(v);
  return v;
}
