import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { cache, createAsync, redirect, useNavigate } from "@solidjs/router";
import {
  createMutation,
  createQuery,
  useQueryClient,
} from "@tanstack/solid-query";
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
import { fetch } from "@tauri-apps/plugin-http";

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
  if (!value) return redirect("/signin");
  const res = await fetch(`${clientEnv.VITE_SERVER_URL}/api/desktop/plan`, {
    headers: { authorization: `Bearer ${value.token}` },
  });
  if (res.status !== 200) return redirect("/signin");
  return value;
}, "getAuth");

export const route = {
  load: () => getAuth(),
};

export default function () {
  const { options, setOptions } = createOptionsQuery();
  const currentRecording = createCurrentRecordingQuery();

  events.showCapturesPanel.listen(() => {
    commands.showPreviousRecordingsWindow();
  });

  onMount(async () => {
    await commands.showPreviousRecordingsWindow();
    // await commands.showNotificationsWindow();
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

  createAsync(() => getAuth());

  createUpdateCheck();

  onMount(async () => {
    if (options.data?.cameraLabel && options.data.cameraLabel !== "No Camera") {
      const cameraWindowActive = await commands.isCameraWindowOpen();

      if (!cameraWindowActive) {
        console.log("cameraWindow not found");
        setOptions({
          ...options.data,
        });
      }
    }
  });

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
            <ChangelogButton />
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
        class="text-gray-400 text-[0.875rem] mx-auto hover:text-gray-500 hover:underline"
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

  return (
    <div class="flex flex-row items-center rounded-[0.5rem] relative border">
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
        selected={props.options?.captureTarget.variant === "screen"}
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

  const onChange = async (item: Option | null) => {
    if (!item && permissions?.data?.camera !== "granted") {
      return requestPermission("camera");
    }
    if (!props.options) return;

    if (!item || !item.isCamera) {
      props.setOptions({
        ...props.options,
        cameraLabel: null,
      });
    } else {
      props.setOptions({
        ...props.options,
        cameraLabel: item.name,
      });
    }
  };

  const selectOptions = createMemo(() => [
    { name: "No Camera", isCamera: false },
    ...videoDevices.map((d) => ({ isCamera: true, name: d })),
  ]);

  const value = () =>
    selectOptions()?.find((o) => o.name === props.options?.cameraLabel) ?? null;

  return (
    <div class="flex flex-col gap-[0.25rem] items-stretch">
      <label class="text-gray-400 text-[0.875rem]">Camera</label>
      <KSelect<Option>
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
              {props.item.rawValue.name}
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
        <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect">
          <IconCapCamera class="text-gray-400 size-[1.25rem]" />
          <KSelect.Value<Option> class="flex-1 text-left truncate">
            {(state) => <span>{state.selectedOption().name}</span>}
          </KSelect.Value>
          <TargetSelectInfoPill
            value={props.options?.cameraLabel ?? null}
            permissionGranted={permissionGranted()}
            requestPermission={() => requestPermission("camera")}
            onClear={() => {
              if (!props.options) return;
              props.setOptions({
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
              class="max-h-36 overflow-y-auto"
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
  const devices = createQuery(() => listAudioDevices);
  const permissions = createQuery(() => getPermissions);
  const currentRecording = createCurrentRecordingQuery();

  const [open, setOpen] = createSignal(false);

  const value = () =>
    devices?.data?.find((d) => d.name === props.options?.audioInputName) ??
    null;

  const requestPermission = useRequestPermission();

  const permissionGranted = () =>
    permissions?.data?.microphone === "granted" ||
    permissions?.data?.microphone === "notNeeded";

  type Option = { name: string; deviceId: string };

  const handleMicrophoneChange = async (item: Option | null) => {
    if (!item || !props.options) return;

    props.setOptions({
      ...props.options,
      audioInputName: item.deviceId !== "" ? item.name : null,
    });
  };

  return (
    <div class="flex flex-col gap-[0.25rem] items-stretch">
      <label class="text-gray-400">Microphone</label>
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
        <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect">
          <IconCapMicrophone class="text-gray-400 size-[1.25rem]" />
          <KSelect.Value<{
            name: string;
          }> class="flex-1 text-left truncate">
            {(state) => (
              <span>{state.selectedOption()?.name ?? "No Audio"}</span>
            )}
          </KSelect.Value>
          <TargetSelectInfoPill
            value={props.options?.audioInputName ?? null}
            permissionGranted={permissionGranted()}
            requestPermission={() => requestPermission("microphone")}
            onClear={() => {
              if (!props.options) return;
              props.setOptions({
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
}) {
  return (
    <KSelect<T | null>
      options={props.options ?? []}
      optionValue="id"
      optionTextValue="name"
      gutter={8}
      itemComponent={(props) => (
        <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
          <KSelect.ItemLabel class="flex-1">
            {props.item.rawValue?.name}
          </KSelect.ItemLabel>
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
          props.options.length === 1
            ? (p) => (
                <button
                  onClick={() => {
                    props.onChange(props.options[0]);
                  }}
                  data-selected={props.selected}
                  class={p.class}
                >
                  <span class="truncate">{props.options[0].name}</span>
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
            <KSelect.Listbox class="max-h-52 max-w-64" as={MenuItemList} />
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
      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/changelog/status?version=${version}`
      );
      return await response.json();
    }
  );

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
      <IconLucideBell class="w-[1.15rem] h-[1.15rem] text-gray-400 hover:text-gray-500" />
      {changelogState.hasUpdate && (
        <div
          style={{ "background-color": "#FF4747" }}
          class="block z-10 absolute top-0 right-0 w-2 h-2 rounded-full animate-bounce"
        />
      )}
    </button>
  );
}
