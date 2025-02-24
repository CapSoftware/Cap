import { Button } from "@cap/ui-solid";
import { Select as KSelect, SelectRootProps } from "@kobalte/core/select";
import { useNavigate } from "@solidjs/router";
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
  ErrorBoundary,
  Suspense,
} from "solid-js";
import { createStore } from "solid-js/store";
import { trackEvent } from "~/utils/analytics";

import {
  createCurrentRecordingQuery,
  createOptionsQuery,
  listWindows,
  listAudioDevices,
  getPermissions,
  createVideoDevicesQuery,
  listScreens,
  createLicenseQuery,
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

  const license = createLicenseQuery();

  createUpdateCheck();

  let unlistenFn: UnlistenFn;
  onCleanup(() => unlistenFn?.());
  const [initialize] = createResource(async () => {
    const version = await getVersion();

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
    const currentWindow = getCurrentWindow();
    const MAIN_WINDOW_SIZE = { width: 300, height: 260 };

    // Set initial size
    await currentWindow.setSize(
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

    unlistenFn = () => {
      unlistenFocus();
      unlistenResize();
    };

    setTitlebar("hideMaximize", true);

    return null;
  });

  return (
    <div class="flex justify-center flex-col p-3 gap-2 text-[0.875rem] font-[400] bg-[--gray-50] h-full text-[--text-primary]">
      {initialize()}
      <div class="*:h-auto text-[--text-primary] ">
        <IconCapLogoFullDark class="hidden dark:block" />
        <IconCapLogoNobox class="block dark:hidden" />
      </div>
      <TargetSelects options={options.data} />
      <CameraSelect options={options.data} setOptions={setOptions} />
      <MicrophoneSelect options={options.data} setOptions={setOptions} />
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
import { UnlistenFn } from "@tauri-apps/api/event";
import { createElementBounds } from "@solid-primitives/bounds";
import Tooltip from "~/components/Tooltip";

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
      "cap-window://capture-area/state/pending",
      (event) => {
          setAreaSelection("pending", event.payload)
        }
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

    const targetScreen = selectedScreen() ?? screens.data?.[0];
    if (!targetScreen) return;

    closeAreaSelection();
    
    // if (isTargetCaptureArea() && props.options) {
    //   trackEvent("crop_area_disabled");
    //   commands.setRecordingOptions({
    //     ...props.options,
    //     captureTarget: { ...targetScreen, variant: "screen" },
    //   });
    //   return;
    // }

    trackEvent("crop_area_enabled", {
      screen_id: targetScreen.id,
      screen_name: targetScreen.name,
    });
    setAreaSelection({ pending: false, screen: targetScreen });
    commands.showWindow({
      CaptureArea: { screen: targetScreen },
    });
  }

  return (
    <div class="flex flex-row gap-3">
      <button
        type="button"
        onClick={handleAreaSelectButtonClick}
        class={cx(
          "flex flex-col flex-1 gap-1 justify-center items-center rounded-lg bg-[--zinc-50]",
          isTargetCaptureArea() ? "ring-2 ring-blue-300 ring-offset-2" : ""
        )}
      >
        <IconCapScan class={"w-5 text-[--zinc-400]"} />
        <p class="text-xs font-medium text-black">Area</p>
      </button>
      <TargetSelect<CaptureScreen>
        options={screens.data ?? []}
        isTargetCaptureArea={isTargetCaptureArea()}
        areaSelectionPending={areaSelection.pending}
        onChange={(value) => {
          if (!value || !props.options) return;

          trackEvent("display_selected", {
            display_id: value.id,
            display_name: value.name,
            refresh_rate: value.refresh_rate,
          });

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
        placeholder={
          <div class="flex flex-col gap-1 justify-center items-center p-2">
            <IconCapMonitor class="w-5 !text-[--zinc-400]" />
            <p class="text-xs font-medium text-black">Screen</p>
          </div>
        }
        class="flex bg-[--zinc-50] rounded-lg flex-1 justify-center items-center"
        optionsEmptyText="No screens found"
        selected={isTargetScreenOrArea()}
      />
      <TargetSelect<CaptureWindow>
        options={windows.data ?? []}
        isTargetCaptureArea={isTargetCaptureArea()}
        onChange={(value) => {
          if (!value || !props.options) return;

          trackEvent("window_selected", {
            window_id: value.id,
            window_name: value.name,
            owner_name: value.owner_name,
            refresh_rate: value.refresh_rate,
          });

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
        placeholder={
          <div class="flex flex-col gap-1 justify-center items-center">
            <IconCapAppWindowMac class="w-5 text-[--zinc-400]" />
            <p class="text-xs font-medium text-black">Window</p>
          </div>
        }
        optionsEmptyText="No windows found"
        class="flex bg-[--zinc-50] rounded-lg flex-1 justify-center items-center"
        selected={props.options?.captureTarget.variant === "window"}
        itemComponent={(props) => (
          <div class="flex overflow-x-hidden flex-col flex-1">
            <div class="w-full truncate">{props.item.rawValue?.name}</div>
            <div class="w-full text-xs">{props.item.rawValue?.owner_name}</div>
          </div>
        )}
      />
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
    await props.setOptions
      .mutateAsync({ ...props.options, cameraLabel })
      .finally(() => setLoading(false));

    trackEvent("camera_selected", {
      camera_name: cameraLabel,
      enabled: !!cameraLabel,
    });
  };

  const selectOptions = createMemo(() => [
    { name: "No Camera", isCamera: false },
    ...videoDevices.map((d) => ({ isCamera: true, name: d })),
  ]);

  const value = () =>
    selectOptions()?.find((o) => o.name === props.options?.cameraLabel) ?? null;

  return (
    <div class="flex flex-col gap-[0.25rem] font-medium items-stretch text-[--text-primary]">
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
          class="flex flex-row items-center p-3
           gap-[0.375rem] bg-[--zinc-50] rounded-lg w-full disabled:text-gray-400 transition-colors KSelect"
        >
          <IconCapCamera class="text-[--zinc-400] size-[1.25rem]" />
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
              class="overflow-y-auto max-h-32"
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
    await props.setOptions
      .mutateAsync({
        ...props.options,
        audioInputName: item.deviceId !== "" ? item.name : null,
      })
      .finally(() => setLoading(false));
    if (!item.deviceId) setDbs();

    trackEvent("microphone_selected", {
      microphone_name: item.deviceId !== "" ? item.name : null,
      enabled: item.deviceId !== "",
    });
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
    <div class="flex flex-col gap-[0.25rem] font-medium items-stretch text-[--text-primary]">
      <KSelect<Option>
        options={[
          { name: "No Microphone", deviceId: "" },
          ...(devices.data ?? []),
        ]}
        optionValue="deviceId"
        optionTextValue="name"
        placeholder="No Microphone"
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
          class="relative flex flex-row items-center p-3 gap-[0.375rem]
           bg-[--zinc-50] rounded-lg w-full disabled:text-gray-400 transition-colors KSelect overflow-hidden z-10"
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
          <IconCapMicrophone class="text-[--zinc-400] size-[1.25rem]" />
          <KSelect.Value<Option> class="flex-1 text-left truncat">
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
              class="overflow-y-auto max-h-36"
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
  class?: string;
  areaSelectionPending?: boolean;
  isTargetCaptureArea?: boolean;
  optionsEmptyText: string;
  placeholder: string | JSX.Element;
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
      data-selected={props.selected}
      class={cx(
        "transition-all duration-200 text-black",
        "data-[selected='false']:ring-0 data-[selected='false']:ring-transparent data-[selected='false']:ring-offset-0",
        props.areaSelectionPending || props.isTargetCaptureArea
          ?  ""
          : "data-[selected='true']:ring-2 data-[selected='true']:ring-blue-300 data-[selected='true']:ring-offset-2",
        props.class
      )}
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
        class="flex overflow-hidden z-10 flex-1 gap-2 justify-center items-center px-2 py-1 w-full text-black transition-colors duration-100 peer focus:outline-none text-nowrap"
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
          <KSelect.Icon class="transition-transform ui-expanded:-rotate-180">
            <IconCapChevronDown class="transition-transform transform size-4 shrink-0" />
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
        "px-2.5 rounded-full text-[0.75rem] text-gray-50",
        props.value !== null && props.permissionGranted
          ? "bg-blue-300"
          : "bg-red-300"
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
