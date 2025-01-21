import { Button } from "@cap/ui-solid";
import { Select as KSelect, SelectRootProps } from "@kobalte/core/select";
import { cache, createAsync, redirect, useNavigate } from "@solidjs/router";
import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { cx } from "cva";
import {
  JSX,
  Show,
  type ValidComponent,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onMount,
  onCleanup,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { fetch } from "@tauri-apps/plugin-http";
import { Tooltip } from "@kobalte/core";

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
import {
  CaptureScreen,
  type CaptureWindow,
  commands,
  events,
} from "~/utils/tauri";
import {
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
  topRightAnimateClasses,
} from "../editor/ui";

const getAuth = cache(async () => {
  const value = await authStore.get();
  const local = import.meta.env.VITE_LOCAL_MODE === "true";

  const res = await apiClient.desktop.getUserPlan({
    headers: await protectedHeaders(),
  });
  if (res.status !== 200 && !local) return redirect("/signin");

  return value;
}, "getAuth");

export const route = {
  load: () => getAuth(),
};

export default function () {
  const { options, setOptions } = createOptionsQuery();
  const currentRecording = createCurrentRecordingQuery();

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

  const [isUpgraded] = createResource(() => commands.checkUpgradedAndUpdate());

  createAsync(() => getAuth());

  createUpdateCheck();

  onMount(async () => {
    if (options.data?.cameraLabel && options.data.cameraLabel !== "No Camera") {
      const cameraWindowActive = await commands.isCameraWindowOpen();

      if (!cameraWindowActive) {
        console.log("cameraWindow not found");
        setOptions.mutate({
          ...options.data,
        });
      }
    }

    // Enforce window size with multiple safeguards
    const currentWindow = await getCurrentWindow();
    const MAIN_WINDOW_SIZE = { width: 300, height: 360 };

    // Set initial size
    currentWindow.setSize(
      new LogicalSize(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height)
    );

    // Check size when app regains focus
    const unlistenFocus = await currentWindow.onFocusChanged(
      ({ payload: focused }) => {
        if (focused) {
          currentWindow.setSize(
            new LogicalSize(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height)
          );
        }
      }
    );

    // Listen for resize events
    const unlistenResize = await currentWindow.onResized(() => {
      currentWindow.setSize(
        new LogicalSize(MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height)
      );
    });

    setTitlebar("hideMaximize", true);
    setTitlebar(
      "items",
      <div
        dir={ostype() === "windows" ? "rtl" : "rtl"}
        class="flex mx-2 items-center gap-[0.3rem]"
      >
        <Button
          variant="secondary"
          size="xs"
          onClick={() => {
            commands.showWindow({ Settings: { page: "feedback" } });
          }}
        >
          Feedback
        </Button>
        <ChangelogButton />
      </div>
    );

    onCleanup(() => {
      unlistenFocus();
      unlistenResize();
    });
  });

  return (
    <div class="flex justify-center flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] bg-[--gray-50] h-full text-[--text-primary]">
      <div class="flex items-center justify-between pb-[0.25rem]">
        <div class="flex items-center space-x-1">
          <div class="*:w-[92px] *:h-auto text-[--text-primary] ">
            <IconCapLogoFullDark class="dark:block hidden" />
            <IconCapLogoFull class="dark:hidden block" />
          </div>
          <span
            onClick={async () => {
              if (!isUpgraded()) {
                await commands.showWindow("Upgrade");
              }
            }}
            class={`text-[0.6rem] ${
              isUpgraded()
                ? "bg-[--blue-400] text-gray-50 dark:text-gray-500"
                : "bg-gray-200 cursor-pointer hover:bg-gray-300"
            } rounded-lg px-1.5 py-0.5`}
          >
            {isUpgraded() ? "Pro" : "Upgrade to Pro"}
          </span>
        </div>
        <div class="flex items-center space-x-2">
          <Tooltip.Root openDelay={0}>
            <Tooltip.Trigger>
              <button
                type="button"
                onClick={() =>
                  commands.showWindow({ Settings: { page: "apps" } })
                }
              >
                <IconLucideLayoutGrid class="w-[1.25rem] h-[1.25rem] text-gray-400 hover:text-gray-500" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-[--gray-500] rounded shadow-lg animate-in fade-in duration-100">
                Cap Apps
                <Tooltip.Arrow class="fill-[--gray-500]" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <Tooltip.Root openDelay={0}>
            <Tooltip.Trigger>
              <button
                type="button"
                onClick={() =>
                  commands.showWindow({ Settings: { page: "recordings" } })
                }
              >
                <IconLucideSquarePlay class="w-[1.25rem] h-[1.25rem] text-gray-400 hover:text-gray-500" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
                Previous Recordings
                <Tooltip.Arrow class="fill-gray-500" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>

          <Tooltip.Root openDelay={0}>
            <Tooltip.Trigger>
              <button
                type="button"
                onClick={() =>
                  commands.showWindow({ Settings: { page: "general" } })
                }
              >
                <IconCapSettings class="w-[1.25rem] h-[1.25rem] text-gray-400 hover:text-gray-500" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
                Settings
                <Tooltip.Arrow class="fill-gray-500" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </div>
      </div>
      <TargetSelects options={options.data} />
      <CameraSelect options={options.data} setOptions={setOptions} />
      <MicrophoneSelect options={options.data} setOptions={setOptions} />
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
        class="text-[--text-tertiary] text-[0.875rem] mx-auto hover:text-[--text-primary] hover:underline"
      >
        Open Cap on Web
      </a>
    </div>
  );
}

function useRequestPermission() {
  const queryClient = useQueryClient();

  async function requestPermission(type: "camera" | "microphone") {
    try {
      if (type === "camera") {
        await commands.resetCameraPermissions();
      } else if (type === "microphone") {
        console.log("wowzers");
        await commands.resetMicrophonePermissions();
      }
      await commands.requestPermission(type);
      await queryClient.refetchQueries(getPermissions);
    } catch (error) {
      console.error(`Failed to get ${type} permission:`, error);
    }
  }

  return requestPermission;
}

import * as dialog from "@tauri-apps/plugin-dialog";
import * as updater from "@tauri-apps/plugin-updater";
import { makePersisted } from "@solid-primitives/storage";
import { setTitlebar } from "~/utils/titlebar-state";
import { type as ostype } from "@tauri-apps/plugin-os";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import { Transition } from "solid-transition-group";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { PENDING_STATE_SET_EVENT } from "../capture-area";

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

function TargetSelects(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
}) {
  const screens = createQuery(() => listScreens);
  const windows = createQuery(() => listWindows);
  const [selectedScreen, setSelectedScreen] =
    createSignal<CaptureScreen | null>(screens?.data?.[0] ?? null);

  const isTargetScreenOrArea = createMemo(
    () =>
      props.options?.captureTarget.variant === "screen" ||
      props.options?.captureTarget.variant === "area"
  );
  const isTargetCaptureArea = createMemo(
    () => props.options?.captureTarget.variant === "area"
  );

  const [areaSelection, setAreaSelection] = createStore({
    pending: false,
    screen: selectedScreen(),
  });

  async function closeAreaSelection() {
    setAreaSelection({ pending: false, screen: null });
    (await WebviewWindow.getByLabel("capture-area"))?.close();
  }

  onMount(async () => {
    const unlistenCaptureAreaWindow =
      await getCurrentWebviewWindow().listen<boolean>(
        PENDING_STATE_SET_EVENT,
        (event) => setAreaSelection("pending", event.payload)
      );
    onCleanup(unlistenCaptureAreaWindow);
  });

  let shouldAnimateAreaSelect = false;
  createEffect(async () => {
    const target = props.options?.captureTarget;
    if (!target) return;

    if (target.variant === "screen") {
      if (target.id !== areaSelection.screen?.id) {
        closeAreaSelection();
      }
      setSelectedScreen(target);
    } else if (target.variant === "window") {
      if (areaSelection.screen) closeAreaSelection();
      shouldAnimateAreaSelect = true;
    }
  });

  async function handleAreaSelectButtonClick() {
    const targetScreen = selectedScreen();
    if (!targetScreen) return;

    closeAreaSelection();
    if (isTargetCaptureArea() && props.options) {
      commands.setRecordingOptions({
        ...props.options,
        captureTarget: { ...targetScreen, variant: "screen" },
      });
      return;
    }

    setAreaSelection({ pending: false, screen: targetScreen });
    commands.showWindow({
      CaptureArea: { screen: targetScreen },
    });
  }

  return (
    <div>
      <Tooltip.Root openDelay={500}>
        <Tooltip.Trigger class="fixed flex flex-row items-center w-8 h-8">
          <Transition
            onEnter={(el, done) => {
              if (shouldAnimateAreaSelect)
                el.animate(
                  [
                    {
                      transform: "scale(0.5)",
                      opacity: 0,
                      width: "0.2rem",
                      height: "0.2rem",
                    },
                    {
                      transform: "scale(1)",
                      opacity: 1,
                      width: "2rem",
                      height: "2rem",
                    },
                  ],
                  {
                    duration: 450,
                    easing: "cubic-bezier(0.65, 0, 0.35, 1)",
                  }
                ).finished.then(done);
              shouldAnimateAreaSelect = true;
            }}
            onExit={(el, done) =>
              el
                .animate(
                  [
                    {
                      transform: "scale(1)",
                      opacity: 1,
                      width: "2rem",
                      height: "2rem",
                    },
                    {
                      transform: "scale(0)",
                      opacity: 0,
                      width: "0.2rem",
                      height: "0.2rem",
                    },
                  ],
                  {
                    duration: 500,
                    easing: "ease-in-out",
                  }
                )
                .finished.then(done)
            }
          >
            {isTargetScreenOrArea() && (
              <button
                type="button"
                disabled={!isTargetScreenOrArea()}
                onClick={handleAreaSelectButtonClick}
                class={cx(
                  "flex items-center justify-center flex-shrink-0 w-full h-full rounded-[0.5rem] transition-all duration-200",
                  "hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400",
                  "focus-visible:outline font-[200] text-[0.875rem]",
                  isTargetCaptureArea()
                    ? "bg-gray-100 text-blue-400 border border-blue-200"
                    : "bg-gray-100 text-gray-400"
                )}
              >
                <IconCapCrop
                  class={`w-[1rem] h-[1rem] ${
                    areaSelection.pending
                      ? "animate-gentle-bounce duration-1000 text-gray-500 mt-1"
                      : ""
                  }`}
                />
              </button>
            )}
          </Transition>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
            {isTargetCaptureArea()
              ? "Remove selection"
              : areaSelection.pending
              ? "Selecting area..."
              : "Select area"}
            <Tooltip.Arrow class="fill-gray-500" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <div
        class={`flex flex-row items-center rounded-[0.5rem] relative border h-8 transition-all duration-500 ${
          isTargetScreenOrArea() ? "ml-[2.4rem]" : ""
        }`}
        style={{
          "transition-timing-function":
            "cubic-bezier(0.785, 0.135, 0.15, 0.86)",
        }}
      >
        <div
          class="w-1/2 absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden"
          style={{
            transform:
              props.options?.captureTarget.variant === "window"
                ? "translateX(100%)"
                : undefined,
          }}
        >
          <div class="bg-gray-100 flex-1" />
        </div>
        <TargetSelect<CaptureScreen>
          options={screens.data ?? []}
          onChange={(value) => {
            if (!value || !props.options) return;

            commands.setRecordingOptions({
              ...props.options,
              captureTarget: { ...value, variant: "screen" },
            });
          }}
          value={
            props.options?.captureTarget.variant === "screen"
              ? props.options.captureTarget
              : null
          }
          placeholder="Screen"
          optionsEmptyText="No screens found"
          selected={isTargetScreenOrArea()}
        />
        <TargetSelect<CaptureWindow>
          options={windows.data ?? []}
          onChange={(value) => {
            if (!props.options) return;

            commands.setRecordingOptions({
              ...props.options,
              captureTarget: { ...value, variant: "window" },
            });
          }}
          value={
            props.options?.captureTarget.variant === "window"
              ? props.options.captureTarget
              : null
          }
          placeholder="Window"
          optionsEmptyText="No windows found"
          selected={props.options?.captureTarget.variant === "window"}
          itemComponent={(props) => (
            <div class="flex-1 flex flex-col overflow-x-hidden">
              <div class="w-full truncate">{props.item.rawValue?.name}</div>
              <div class="w-full text-xs">
                {props.item.rawValue?.owner_name}
              </div>
            </div>
          )}
        />
      </div>
    </div>
  );
}

function CameraSelect(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
  setOptions: ReturnType<typeof createOptionsQuery>["setOptions"];
}) {
  const videoDevices = createVideoDevicesQuery();
  const currentRecording = createCurrentRecordingQuery();
  const permissions = createQuery(() => getPermissions);
  const requestPermission = useRequestPermission();

  const [open, setOpen] = createSignal(false);

  const permissionGranted = () =>
    permissions?.data?.camera === "granted" ||
    permissions?.data?.camera === "notNeeded";

  type Option = { isCamera: boolean; name: string };

  const [loading, setLoading] = createSignal(false);
  const onChange = async (item: Option | null) => {
    if (!item && permissions?.data?.camera !== "granted") {
      return requestPermission("camera");
    }
    if (!props.options) return;

    let cameraLabel = !item || !item.isCamera ? null : item.name;

    setLoading(true);
    props.setOptions
      .mutateAsync({ ...props.options, cameraLabel })
      .finally(() => setLoading(false));
  };

  const selectOptions = createMemo(() => [
    { name: "No Camera", isCamera: false },
    ...videoDevices.map((d) => ({ isCamera: true, name: d })),
  ]);

  const value = () =>
    selectOptions()?.find((o) => o.name === props.options?.cameraLabel) ?? null;

  return (
    <div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      <label class="text-[--text-tertiary] text-[0.875rem]">Camera</label>
      <KSelect<Option | null>
        options={selectOptions()}
        optionValue="name"
        optionTextValue="name"
        placeholder="No Camera"
        value={value()}
        disabled={!!currentRecording.data}
        onChange={onChange}
        itemComponent={(props) => (
          <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
            <KSelect.ItemLabel class="flex-1">
              {props.item.rawValue?.name}
            </KSelect.ItemLabel>
          </MenuItem>
        )}
        open={open()}
        onOpenChange={(isOpen) => {
          if (!permissionGranted()) {
            requestPermission("camera");
            return;
          }

          setOpen(isOpen);
        }}
      >
        <KSelect.Trigger
          disabled={loading()}
          class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect"
        >
          <IconCapCamera class="text-gray-400 size-[1.25rem]" />
          <KSelect.Value<Option | null> class="flex-1 text-left truncate">
            {(state) => <span>{state.selectedOption()?.name}</span>}
          </KSelect.Value>
          <TargetSelectInfoPill
            value={props.options?.cameraLabel ?? null}
            permissionGranted={permissionGranted()}
            requestPermission={() => requestPermission("camera")}
            onClear={() => {
              if (!props.options) return;
              props.setOptions.mutate({
                ...props.options,
                cameraLabel: null,
              });
            }}
          />
        </KSelect.Trigger>
        <KSelect.Portal>
          <PopperContent<typeof KSelect.Content>
            as={KSelect.Content}
            class={topLeftAnimateClasses}
          >
            <MenuItemList<typeof KSelect.Listbox>
              class="max-h-32 overflow-y-auto"
              as={KSelect.Listbox}
            />
          </PopperContent>
        </KSelect.Portal>
      </KSelect>
    </div>
  );
}

function MicrophoneSelect(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
  setOptions: ReturnType<typeof createOptionsQuery>["setOptions"];
}) {
  const DB_SCALE = 40;

  const devices = createQuery(() => listAudioDevices);
  const permissions = createQuery(() => getPermissions);
  const currentRecording = createCurrentRecordingQuery();

  const [open, setOpen] = createSignal(false);
  const [dbs, setDbs] = createSignal<number | undefined>();
  const [isInitialized, setIsInitialized] = createSignal(false);

  const value = createMemo(() => {
    if (!props.options?.audioInputName) return null;
    return (
      devices.data?.find((d) => d.name === props.options!.audioInputName) ??
      null
    );
  });

  const requestPermission = useRequestPermission();

  const permissionGranted = () =>
    permissions?.data?.microphone === "granted" ||
    permissions?.data?.microphone === "notNeeded";

  type Option = { name: string; deviceId: string };

  const [loading, setLoading] = createSignal(false);
  const handleMicrophoneChange = async (item: Option | null) => {
    if (!item || !props.options) return;

    setLoading(true);
    props.setOptions
      .mutateAsync({
        ...props.options,
        audioInputName: item.deviceId !== "" ? item.name : null,
      })
      .finally(() => setLoading(false));
    if (!item.deviceId) setDbs();
  };

  // Create a single event listener using onMount
  onMount(() => {
    const listener = (event: Event) => {
      const dbs = (event as CustomEvent<number>).detail;
      if (!props.options?.audioInputName) setDbs();
      else setDbs(dbs);
    };

    events.audioInputLevelChange.listen((dbs) => {
      if (!props.options?.audioInputName) setDbs();
      else setDbs(dbs.payload);
    });

    return () => {
      window.removeEventListener("audioLevelChange", listener);
    };
  });

  // visual audio level from 0 -> 1
  const audioLevel = () =>
    Math.pow(1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE, 0.5);

  // Initialize audio input if needed - only once when component mounts
  onMount(() => {
    const audioInput = props.options?.audioInputName;
    if (!audioInput || !permissionGranted() || isInitialized()) return;

    setIsInitialized(true);
    handleMicrophoneChange({
      name: audioInput,
      deviceId: audioInput,
    });
  });

  return (
    <div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      <label class="text-[--text-tertiary]">Microphone</label>
      <KSelect<Option>
        options={[{ name: "No Audio", deviceId: "" }, ...(devices.data ?? [])]}
        optionValue="deviceId"
        optionTextValue="name"
        placeholder="No Audio"
        value={value()}
        disabled={!!currentRecording.data}
        onChange={handleMicrophoneChange}
        itemComponent={(props) => (
          <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
            <KSelect.ItemLabel class="flex-1">
              {props.item.rawValue.name}
            </KSelect.ItemLabel>
          </MenuItem>
        )}
        open={open()}
        onOpenChange={(isOpen) => {
          if (!permissionGranted()) {
            requestPermission("microphone");
            return;
          }

          setOpen(isOpen);
        }}
      >
        <KSelect.Trigger
          disabled={loading()}
          class="relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect overflow-hidden z-10"
        >
          <Show when={dbs()}>
            {(s) => (
              <div
                class="bg-blue-100 opacity-50 left-0 inset-y-0 absolute -z-10 transition-[right] duration-100"
                style={{
                  right: `${audioLevel() * 100}%`,
                }}
              />
            )}
          </Show>
          <IconCapMicrophone class="text-gray-400 size-[1.25rem]" />
          <KSelect.Value<Option> class="flex-1 text-left truncate">
            {(state) => {
              const selected = state.selectedOption();
              return (
                <span>
                  {selected?.name ??
                    props.options?.audioInputName ??
                    "No Audio"}
                </span>
              );
            }}
          </KSelect.Value>
          <TargetSelectInfoPill
            value={props.options?.audioInputName ?? null}
            permissionGranted={permissionGranted()}
            requestPermission={() => requestPermission("microphone")}
            onClear={() => {
              if (!props.options) return;
              props.setOptions.mutate({
                ...props.options,
                audioInputName: null,
              });
            }}
          />
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
  );
}

function TargetSelect<T extends { id: number; name: string }>(props: {
  options: Array<T>;
  onChange: (value: T) => void;
  value: T | null;
  selected: boolean;
  optionsEmptyText: string;
  placeholder: string;
  itemComponent?: (
    props: Parameters<
      NonNullable<SelectRootProps<T | null>["itemComponent"]>
    >[0]
  ) => JSX.Element;
}) {
  createEffect(() => {
    const v = props.value;
    if (!v) return;

    if (!props.options.some((o) => o.id === v.id)) {
      props.onChange(props.options[0] ?? null);
    }
  });

  return (
    <KSelect<T | null>
      options={props.options ?? []}
      optionValue="id"
      optionTextValue="name"
      gutter={8}
      itemComponent={(itemProps) => (
        <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={itemProps.item}>
          {/* <KSelect.ItemLabel class="flex-1"> */}
          {props?.itemComponent?.(itemProps) ?? itemProps.item.rawValue?.name}
          {/* </KSelect.ItemLabel> */}
        </MenuItem>
      )}
      placement="bottom"
      class="max-w-[50%] w-full z-10"
      placeholder={props.placeholder}
      onChange={(value) => {
        if (!value) return;
        props.onChange(value);
      }}
      value={props.value}
    >
      <KSelect.Trigger<ValidComponent>
        as={
          props.options.length <= 1
            ? (p) => (
                <button
                  onClick={() => {
                    props.onChange(props.options[0]);
                  }}
                  data-selected={props.selected}
                  class={p.class}
                >
                  <span class="truncate">{props.placeholder}</span>
                </button>
              )
            : undefined
        }
        class="flex-1 text-gray-400 py-1 z-10 data-[selected='true']:text-gray-500 peer focus:outline-none transition-colors duration-100 w-full text-nowrap overflow-hidden px-2 flex gap-2 items-center justify-center"
        data-selected={props.selected}
        onClick={(e) => {
          if (props.options.length === 1) {
            e.preventDefault();
            props.onChange(props.options[0]);
          }
        }}
      >
        <KSelect.Value<CaptureScreen | undefined> class="truncate">
          {(value) => value.selectedOption()?.name}
        </KSelect.Value>
        {props.options.length > 1 && (
          <KSelect.Icon class="ui-expanded:-rotate-180 transition-transform">
            <IconCapChevronDown class="size-4 shrink-0 transform transition-transform" />
          </KSelect.Icon>
        )}
      </KSelect.Trigger>
      <KSelect.Portal>
        <PopperContent<typeof KSelect.Content>
          as={KSelect.Content}
          class={topRightAnimateClasses}
        >
          <Show
            when={props.options.length > 0}
            fallback={
              <div class="p-2 text-gray-500">{props.optionsEmptyText}</div>
            }
          >
            <KSelect.Listbox class="max-h-52 max-w-[17rem]" as={MenuItemList} />
          </Show>
        </PopperContent>
      </KSelect.Portal>
    </KSelect>
  );
}

function TargetSelectInfoPill<T>(props: {
  value: T | null;
  permissionGranted: boolean;
  requestPermission: () => void;
  onClear: () => void;
}) {
  return (
    <button
      type="button"
      class={cx(
        "px-[0.375rem] rounded-full text-[0.75rem]",
        props.value !== null && props.permissionGranted
          ? "bg-blue-50 text-blue-300"
          : "bg-red-50 text-red-300"
      )}
      onPointerDown={(e) => {
        if (!props.permissionGranted || props.value === null) return;

        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();

        if (!props.permissionGranted) {
          props.requestPermission();
          return;
        }

        props.onClear();
      }}
    >
      {!props.permissionGranted
        ? "Request Permission"
        : props.value !== null
        ? "On"
        : "Off"}
    </button>
  );
}

function ChangelogButton() {
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
      const response = await apiClient.desktop.getChangelogStatus({
        query: { version },
      });
      if (response.status === 200) return response.body;
      return null;
    }
  );

  const handleChangelogClick = () => {
    commands.showWindow({ Settings: { page: "changelog" } });
    const version = currentVersion();
    if (version) {
      setChangelogState({
        hasUpdate: false,
        lastOpenedVersion: version,
        changelogClicked: true,
      });
    }
  };

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

  return (
    <button type="button" onClick={handleChangelogClick} class="relative">
      <IconLucideBell class="size-[1.10rem] text-gray-400 hover:text-gray-500" />
      {changelogState.hasUpdate && (
        <div
          style={{ "background-color": "#FF4747" }}
          class="block z-10 absolute top-0 right-0 size-1.5 rounded-full animate-bounce"
        />
      )}
    </button>
  );
}
