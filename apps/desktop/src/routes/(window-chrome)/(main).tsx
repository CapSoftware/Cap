import { Button } from "@cap/ui-solid";
import { Tooltip } from "@kobalte/core";
import { useNavigate } from "@solidjs/router";
import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { cx } from "cva";
import {
  ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { createStore } from "solid-js/store";

import Mode from "~/components/Mode";
import { trackEvent } from "~/utils/analytics";
import {
  createCurrentRecordingQuery,
  createLicenseQuery,
  createOptionsQuery,
  createVideoDevicesQuery,
  getPermissions,
  listAudioDevices,
  listScreens,
  listWindows,
} from "~/utils/queries";
import {
  type CaptureScreen,
  type CaptureWindow,
  commands,
  events,
} from "~/utils/tauri";

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
      height: 290 + (window.FLAGS.systemAudioRecording ? 60 : 0),
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
        class="flex gap-1 items-center mx-2"
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
              <IconCapSettings class="text-gray-400 size-5 hover:text-gray-500" />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg duration-100 animate-in fade-in">
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
              class="flex justify-center items-center w-5 h-5"
            >
              <IconLucideSquarePlay class="text-gray-400 size-5 hover:text-gray-500" />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg duration-100 animate-in fade-in">
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
            class="flex relative justify-center items-center w-5 h-5"
          >
            <IconLucideGift class="text-gray-400 size-5 hover:text-gray-500" />
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
            class="flex justify-center items-center w-5 h-5"
          >
            <IconLucideBug class="text-gray-400 size-5 hover:text-gray-500" />
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
            <IconCapLogoFullDark class="hidden dark:block" />
            <IconCapLogoFull class="block dark:hidden" />
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
      <div class="flex items-center space-x-1 w-full">
        <Button
          disabled={toggleRecording.isPending}
          variant={isRecording() ? "destructive" : "primary"}
          size="md"
          onClick={() => toggleRecording.mutate()}
          class="flex flex-grow justify-center items-center"
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

import { makePersisted } from "@solid-primitives/storage";
import { UnlistenFn } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype, platform } from "@tauri-apps/plugin-os";
import * as updater from "@tauri-apps/plugin-updater";
import { Transition } from "solid-transition-group";

import { setTitlebar } from "~/utils/titlebar-state";
import { apiClient } from "~/utils/web-api";

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

  createEffect(() => {
    screenValue();
    windowValue();
  });

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
        <Tooltip.Trigger class="flex fixed flex-row items-center w-8 h-8">
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
          <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg duration-100 animate-in fade-in">
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
          <div class="flex-1 bg-gray-100" />
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
          getName={(value) =>
            platform() === "windows"
              ? value.name
              : `${value.owner_name} | ${value.name}`
          }
        />
      </div>
    </div>
  );
}

const NO_CAMERA = "No Camera";

function CameraSelect(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
  setOptions: ReturnType<typeof createOptionsQuery>["setOptions"];
}) {
  const videoDevices = createVideoDevicesQuery();
  const currentRecording = createCurrentRecordingQuery();
  const permissions = createQuery(() => getPermissions);
  const requestPermission = useRequestPermission();

  const permissionGranted = () =>
    permissions?.data?.camera === "granted" ||
    permissions?.data?.camera === "notNeeded";

  const onChange = async (cameraLabel: string | null) => {
    if (!cameraLabel && permissions?.data?.camera !== "granted") {
      return requestPermission("camera");
    }
    if (!props.options) return;

    await props.setOptions.mutateAsync({ ...props.options, cameraLabel });

    trackEvent("camera_selected", {
      camera_name: cameraLabel,
      enabled: !!cameraLabel,
    });
  };

  return (
    <div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      <button
        disabled={props.setOptions.isPending || !!currentRecording.data}
        class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect"
        onClick={() => {
          Promise.all([
            CheckMenuItem.new({
              text: NO_CAMERA,
              checked: !props.options?.cameraLabel,
              action: () => onChange(null),
            }),
            PredefinedMenuItem.new({ item: "Separator" }),
            ...videoDevices.map((o) =>
              CheckMenuItem.new({
                text: o,
                checked: o === props.options?.cameraLabel,
                action: () => onChange(o),
              })
            ),
          ])
            .then((items) => Menu.new({ items }))
            .then((m) => {
              m.popup();
            });
        }}
      >
        <IconCapCamera class="text-gray-400 size-[1.25rem]" />
        <span class="flex-1 text-left truncate">
          {props.options?.cameraLabel ?? NO_CAMERA}
        </span>
        <TargetSelectInfoPill
          value={props.options?.cameraLabel ?? null}
          permissionGranted={permissionGranted()}
          requestPermission={() => requestPermission("camera")}
          onClick={(e) => {
            if (!props.options) return;
            if (props.options.cameraLabel) {
              e.stopPropagation();
              props.setOptions.mutate({
                ...props.options,
                cameraLabel: null,
              });
            }
          }}
        />
      </button>
    </div>
  );
}

const NO_MICROPHONE = "No Microphone";

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
    if (!props.options) return;

    await props.setOptions.mutateAsync({
      ...props.options,
      audioInputName: item ? item.name : null,
    });
    if (!item) setDbs();

    trackEvent("microphone_selected", {
      microphone_name: item?.name ?? null,
      enabled: !!item,
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
      <button
        disabled={props.setOptions.isPending || !!currentRecording.data}
        class="relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect overflow-hidden z-10"
        onClick={() => {
          Promise.all([
            CheckMenuItem.new({
              text: NO_MICROPHONE,
              checked: !props.options?.audioInputName,
              action: () => handleMicrophoneChange(null),
            }),
            PredefinedMenuItem.new({ item: "Separator" }),
            ...(devices.data ?? []).map((o) =>
              CheckMenuItem.new({
                text: o.name,
                checked: o.name === props.options?.audioInputName,
                action: () => handleMicrophoneChange(o),
              })
            ),
          ])
            .then((items) => Menu.new({ items }))
            .then((m) => {
              m.popup();
            });
        }}
      >
        <Show when={dbs()}>
          {(_) => (
            <div
              class="bg-blue-100 opacity-50 left-0 inset-y-0 absolute -z-10 transition-[right] duration-100"
              style={{
                right: `${audioLevel() * 100}%`,
              }}
            />
          )}
        </Show>
        <IconCapMicrophone class="text-gray-400 size-[1.25rem]" />
        <span class="flex-1 text-left truncate">
          {props.options?.audioInputName ?? NO_MICROPHONE}
        </span>
        <TargetSelectInfoPill
          value={props.options?.audioInputName ?? null}
          permissionGranted={permissionGranted()}
          requestPermission={() => requestPermission("microphone")}
          onClick={(e) => {
            if (!props.options) return;
            if (props.options?.audioInputName) {
              e.stopPropagation();
              props.setOptions.mutate({
                ...props.options,
                audioInputName: null,
              });
            }
          }}
        />
      </button>
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
  getName?: (value: T) => string;
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

  const getName = (value?: T) =>
    value ? props.getName?.(value) ?? value.name : props.placeholder;

  return (
    <>
      <button
        class="group flex-1 text-gray-400 py-1 z-10 data-[selected='true']:text-gray-500 disabled:text-gray-400 peer focus:outline-none transition-colors duration-100 w-full text-nowrap overflow-hidden px-2 flex gap-2 items-center justify-center"
        data-selected={props.selected}
        onClick={() => {
          if (props.options.length > 1) {
            Promise.all(
              props.options.map((o) =>
                CheckMenuItem.new({
                  text: getName(o),
                  checked: o === props.value,
                  action: () => props.onChange(o),
                })
              )
            )
              .then((items) => Menu.new({ items }))
              .then((m) => {
                m.popup();
              });
          } else if (props.options.length === 1)
            props.onChange(props.options[0]);
        }}
      >
        {props.options.length <= 1 ? (
          <span class="truncate">{props.placeholder}</span>
        ) : (
          <>
            <span class="truncate">{value()?.name ?? props.placeholder}</span>
            <IconCapChevronDown class="shrink-0 size-4" />
          </>
        )}
      </button>
    </>
  );
}

function TargetSelectInfoPill<T>(props: {
  value: T | null;
  permissionGranted: boolean;
  requestPermission: () => void;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <InfoPill
      variant={props.value !== null && props.permissionGranted ? "blue" : "red"}
      onPointerDown={(e) => {
        if (!props.permissionGranted || props.value === null) return;

        e.stopPropagation();
      }}
      onClick={(e) => {
        if (!props.permissionGranted) {
          props.requestPermission();
          return;
        }

        props.onClick(e);
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
          class="flex relative justify-center items-center w-5 h-5"
        >
          <IconLucideBell class="text-gray-400 size-5 hover:text-gray-500" />
          {changelogState.hasUpdate && (
            <div
              style={{ "background-color": "#FF4747" }}
              class="block z-10 absolute top-0 right-0 size-1.5 rounded-full animate-bounce"
            />
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg duration-100 animate-in fade-in">
          Changelog
          <Tooltip.Arrow class="fill-gray-500" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
