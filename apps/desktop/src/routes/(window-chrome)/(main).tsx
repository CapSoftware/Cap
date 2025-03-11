import { Button } from "@cap/ui-solid";
import { Select as KSelect, SelectRootProps } from "@kobalte/core/select";
import { useNavigate } from "@solidjs/router";
import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { cx } from "cva";
import {
  type JSX,
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
  ComponentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Tooltip } from "@kobalte/core";
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
  type CaptureScreen,
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
import Mode from "~/components/Mode";

export default function () {
  const { options, setOptions } = createOptionsQuery();
  const currentRecording = createCurrentRecordingQuery();

  const isRecording = () => !!currentRecording.data;

  const screens = createQuery(() => listScreens);
  const windows = createQuery(() => listWindows);
  const toggleRecording = createMutation(() => ({
    mutationFn: async () => {
      if (!isRecording()) {
        let captureTarget = options.data?.captureTarget ?? {
          variant: "screen",
          id: screens.data?.[0]?.id ?? 1,
        };

        if (captureTarget.variant === "screen") {
          const id = captureTarget.id;
          if (!screens.data?.some((s) => s.id === id))
            captureTarget = { variant: "screen", id: captureTarget.id };
        } else if (captureTarget.variant === "window") {
          const id = captureTarget.id;
          if (!windows.data?.some((w) => w.id === id))
            captureTarget = { variant: "window", id: captureTarget.id };
        }

        await commands.startRecording({
          captureTarget,
          mode: options.data?.mode ?? "studio",
          cameraLabel: options.data?.cameraLabel ?? null,
          audioInputName: options.data?.audioInputName ?? null,
          captureSystemAudio: options.data?.captureSystemAudio,
        });
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
    const MAIN_WINDOW_SIZE = {
      width: 300,
      height: 320 + (window.FLAGS.systemAudioRecording ? 40 : 0),
    };

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
    setTitlebar(
      "items",
      <div
        dir={ostype() === "windows" ? "rtl" : "rtl"}
        class="flex mx-2 items-center gap-1"
      >
        <Tooltip.Root openDelay={0}>
          <Tooltip.Trigger>
            <button
              type="button"
              onClick={() =>
                commands.showWindow({ Settings: { page: "general" } })
              }
              class="flex items-center justify-center w-5 h-5 -ml-[1.5px]"
            >
              <IconCapSettings class="size-5 text-gray-400 hover:text-gray-500" />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
              Settings
              <Tooltip.Arrow class="fill-gray-500" />
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
              class="flex items-center justify-center w-5 h-5"
            >
              <IconLucideSquarePlay class="size-5 text-gray-400 hover:text-gray-500" />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
              Previous Recordings
              <Tooltip.Arrow class="fill-gray-500" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>

        <ChangelogButton />

        <Show when={!license.isLoading && license.data?.type === "personal"}>
          <button
            type="button"
            onClick={() => commands.showWindow("Upgrade")}
            class="relative flex items-center justify-center w-5 h-5"
          >
            <IconLucideGift class="size-5 text-gray-400 hover:text-gray-500" />
            <div
              style={{ "background-color": "#FF4747" }}
              class="block z-10 absolute top-0 right-0 size-1.5 rounded-full animate-bounce"
            />
          </button>
        </Show>

        {import.meta.env.DEV && (
          <button
            type="button"
            onClick={() => {
              new WebviewWindow("debug", { url: "/debug" });
            }}
            class="flex items-center justify-center w-5 h-5"
          >
            <IconLucideBug class="size-5 text-gray-400 hover:text-gray-500" />
          </button>
        )}
      </div>
    );

    return null;
  });

  return (
    <div class="flex justify-center flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] bg-[--gray-50] h-full text-[--text-primary]">
      {initialize()}
      <div class="flex items-center justify-between pb-[0.25rem]">
        <div class="flex items-center space-x-1">
          <a
            class="*:w-[92px] *:h-auto text-[--text-primary]"
            target="_blank"
            href={import.meta.env.VITE_SERVER_URL}
          >
            <IconCapLogoFullDark class="dark:block hidden" />
            <IconCapLogoFull class="dark:hidden block" />
          </a>
          <ErrorBoundary fallback={<></>}>
            <Suspense>
              <span
                onClick={async () => {
                  if (license.data?.type !== "pro") {
                    await commands.showWindow("Upgrade");
                  }
                }}
                class={`text-[0.6rem] ${
                  license.data?.type === "pro"
                    ? "bg-[--blue-400] text-gray-50 dark:text-gray-500"
                    : "bg-gray-200 cursor-pointer hover:bg-gray-300"
                } rounded-lg px-1.5 py-0.5`}
              >
                {license.data?.type === "commercial"
                  ? "Commercial"
                  : license.data?.type === "pro"
                  ? "Pro"
                  : "Personal"}
              </span>
            </Suspense>
          </ErrorBoundary>
        </div>
        <Mode />
      </div>
      <TargetSelects options={options.data} setOptions={setOptions} />
      <CameraSelect options={options.data} setOptions={setOptions} />
      <MicrophoneSelect options={options.data} setOptions={setOptions} />
      {window.FLAGS.systemAudioRecording && (
        <SystemAudio options={options.data} setOptions={setOptions} />
      )}
      <div class="w-full flex items-center space-x-1">
        <Button
          disabled={toggleRecording.isPending}
          variant={isRecording() ? "destructive" : "primary"}
          size="md"
          onClick={() => toggleRecording.mutate()}
          class="flex-grow flex items-center justify-center"
        >
          {isRecording() ? (
            "Stop Recording"
          ) : (
            <>
              {options.data?.mode === "instant" ? (
                <IconCapInstant class="w-[0.8rem] h-[0.8rem] mr-1.5" />
              ) : (
                <IconCapFilmCut class="w-[0.8rem] h-[0.8rem] mr-2 -mt-[1.5px]" />
              )}
              Start Recording
            </>
          )}
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
import { Webview } from "@tauri-apps/api/webview";
import { UnlistenFn } from "@tauri-apps/api/event";
import { isDev } from "solid-js/web";

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
  setOptions: ReturnType<typeof createOptionsQuery>["setOptions"];
}) {
  const screens = createQuery(() => listScreens);
  const windows = createQuery(() => listWindows);
  const [selectedScreen, setSelectedScreen] = createSignal<{
    id: number;
  } | null>(screens?.data?.[0] ?? null);

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
        (event) => setAreaSelection("pending", event.payload)
      );
    onCleanup(unlistenCaptureAreaWindow);
  });

  let shouldAnimateAreaSelect = false;
  createEffect(async () => {
    const target = props.options?.captureTarget;
    if (!target) return;

    if (target.variant === "screen") {
      if (target.id !== areaSelection.screen?.id) closeAreaSelection();

      setSelectedScreen(target);
    } else if (target.variant === "window") {
      if (areaSelection.screen) closeAreaSelection();
      shouldAnimateAreaSelect = true;
    }
  });

  async function handleAreaSelectButtonClick() {
    const targetScreen = selectedScreen() ?? screens.data?.[0];
    console.log({ targetScreen });
    if (!targetScreen) return;

    closeAreaSelection();
    if (isTargetCaptureArea() && props.options) {
      trackEvent("crop_area_disabled");
      commands.setRecordingOptions({
        ...props.options,
        captureTarget: { ...targetScreen, variant: "screen" },
      });
      return;
    }

    const screen = screens.data?.find((s) => s.id === targetScreen.id);
    if (!screen) return;
    trackEvent("crop_area_enabled", {
      screen_id: screen.id,
      screen_name: screen.name,
    });
    setAreaSelection({ pending: false, screen: { id: screen.id } });
    commands.showWindow({
      CaptureArea: { screen_id: screen.id },
    });
  }

  const screenValue = () => {
    const captureTarget = props.options?.captureTarget;
    if (
      captureTarget?.variant !== "screen" &&
      captureTarget?.variant !== "area"
    )
      return null;

    const screenId =
      captureTarget.variant === "screen"
        ? captureTarget.id
        : captureTarget.screen;

    const value =
      screens.data?.find((d) => d.id === screenId) ?? screens.data?.[0] ?? null;

    if (
      value &&
      screenId !== value.id &&
      props.options &&
      !props.setOptions.isPending
    ) {
      props.setOptions.mutate({
        ...props.options,
        captureTarget: { variant: "screen", id: value.id },
      });
    }

    return value;
  };

  const windowValue = () => {
    const captureTarget = props.options?.captureTarget;
    if (captureTarget?.variant !== "window") return null;

    const value =
      windows.data?.find((d) => d.id === captureTarget.id) ??
      windows.data?.[0] ??
      null;

    if (
      value &&
      captureTarget.id !== value.id &&
      props.options &&
      !props.setOptions.isPending
    ) {
      props.setOptions.mutate({
        ...props.options,
        captureTarget: { variant: "window", id: value.id },
      });
    }

    return value;
  };

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
            <Show when={isTargetScreenOrArea()}>
              {(targetScreenOrArea) => (
                <button
                  type="button"
                  disabled={!targetScreenOrArea}
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
            </Show>
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
          value={screenValue()}
          placeholder="Screen"
          optionsEmptyText="No screens found"
          selected={isTargetScreenOrArea()}
          disabled={props.setOptions.isPending}
        />
        <TargetSelect<CaptureWindow>
          disabled={props.setOptions.isPending}
          options={windows.data ?? []}
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
          value={windowValue()}
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

  const onChange = async (item: Option | null) => {
    if (!item && permissions?.data?.camera !== "granted") {
      return requestPermission("camera");
    }
    if (!props.options) return;

    const cameraLabel = !item || !item.isCamera ? null : item.name;

    await props.setOptions.mutateAsync({ ...props.options, cameraLabel });

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
    <div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      {/* <label class="text-[--text-tertiary] text-[0.875rem]">Camera</label> */}
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
          disabled={props.setOptions.isPending}
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
      devices.data?.find((d) => d.name === props.options?.audioInputName) ??
      null
    );
  });

  const requestPermission = useRequestPermission();

  const permissionGranted = () =>
    permissions?.data?.microphone === "granted" ||
    permissions?.data?.microphone === "notNeeded";

  type Option = { name: string; deviceId: string };

  const handleMicrophoneChange = async (item: Option | null) => {
    if (!item || !props.options) return;

    await props.setOptions.mutateAsync({
      ...props.options,
      audioInputName: item.deviceId !== "" ? item.name : null,
    });
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
    <div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      {/* <label class="text-[--text-tertiary]">Microphone</label> */}
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
          disabled={props.setOptions.isPending}
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

function SystemAudio(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
  setOptions: ReturnType<typeof createOptionsQuery>["setOptions"];
}) {
  const currentRecording = createCurrentRecordingQuery();

  return (
    <button
      onClick={() => {
        if (!props.options) return;
        props.setOptions.mutate({
          ...props.options,
          captureSystemAudio: !props.options?.captureSystemAudio,
        });
      }}
      disabled={props.setOptions.isPending || !!currentRecording.data}
      class="relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect overflow-hidden z-10"
    >
      <div class="size-[1.25rem] flex items-center justify-center">
        <IconPhMonitorBold class="text-gray-400 stroke-2 size-[1.2rem]" />
      </div>
      <span class="flex-1 text-left truncate">
        {props.options?.captureSystemAudio
          ? "Record System Audio"
          : "No System Audio"}
      </span>
      <InfoPill variant={props.options?.captureSystemAudio ? "blue" : "red"}>
        {props.options?.captureSystemAudio ? "On" : "Off"}
      </InfoPill>
    </button>
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
  disabled?: boolean;
}) {
  const value = () => {
    const v = props.value;
    if (!v) return null;

    const o = props.options.find((o) => o.id === v.id);
    if (o) return props.value;

    props.onChange(props.options[0]);
    return props.options[0];
  };

  return (
    <KSelect<T | null>
      options={props.options ?? []}
      optionValue="id"
      optionTextValue="name"
      gutter={8}
      itemComponent={(itemProps) => (
        <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={itemProps.item}>
          {props?.itemComponent?.(itemProps) ?? itemProps.item.rawValue?.name}
        </MenuItem>
      )}
      placement="bottom"
      class="max-w-[50%] w-full z-10 disabled:text-opacity-80"
      placeholder={props.placeholder}
      onChange={(value) => {
        if (!value) return;
        props.onChange(value);
      }}
      value={value()}
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
        class="flex-1 text-gray-400 py-1 z-10 data-[selected='true']:text-gray-500 disabled:text-gray-400 peer focus:outline-none transition-colors duration-100 w-full text-nowrap overflow-hidden px-2 flex gap-2 items-center justify-center"
        disabled={props.disabled}
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
    <InfoPill
      variant={props.value !== null && props.permissionGranted ? "blue" : "red"}
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
    </InfoPill>
  );
}

function InfoPill(
  props: ComponentProps<"button"> & { variant: "blue" | "red" }
) {
  return (
    <button
      {...props}
      type="button"
      class={cx(
        "px-[0.375rem] rounded-full text-[0.75rem]",
        props.variant === "blue"
          ? "bg-blue-50 text-blue-300"
          : "bg-red-50 text-red-300"
      )}
    />
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
    <Tooltip.Root openDelay={0}>
      <Tooltip.Trigger>
        <button
          type="button"
          onClick={handleChangelogClick}
          class="relative flex items-center justify-center w-5 h-5"
        >
          <IconLucideBell class="size-5 text-gray-400 hover:text-gray-500" />
          {changelogState.hasUpdate && (
            <div
              style={{ "background-color": "#FF4747" }}
              class="block z-10 absolute top-0 right-0 size-1.5 rounded-full animate-bounce"
            />
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
          Changelog
          <Tooltip.Arrow class="fill-gray-500" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
