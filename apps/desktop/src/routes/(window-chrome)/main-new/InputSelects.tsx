import { createQuery } from "@tanstack/solid-query";
import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/window";
import { Show, createMemo, createSignal, onMount } from "solid-js";
import { trackEvent } from "~/utils/analytics";

import { TargetSelectInfoPill } from "~/components";
import { useRequestPermission } from "~/hooks";
import {
  createCurrentRecordingQuery,
  createOptionsQuery,
  createVideoDevicesQuery,
  getPermissions,
  listAudioDevices,
} from "~/utils/queries";
import { events } from "~/utils/tauri";

function CameraSelect(props: {
  options: ReturnType<typeof createOptionsQuery>["options"]["data"];
  setOptions: ReturnType<typeof createOptionsQuery>["setOptions"];
}) {
  const videoDevices = createVideoDevicesQuery();
  const currentRecording = createCurrentRecordingQuery();
  const permissions = createQuery(() => getPermissions);
  const requestPermission = useRequestPermission();
  const [loading, setLoading] = createSignal(false);

  const permissionGranted = () =>
    permissions?.data?.camera === "granted" ||
    permissions?.data?.camera === "notNeeded";

  type Option = { isCamera: boolean; name: string };

  const selectOptions = createMemo(() => [
    { name: "No Camera", isCamera: false },
    ...videoDevices.map((d) => ({ isCamera: true, name: d })),
  ]);

  const value = () =>
    selectOptions()?.find((o) => o.name === props.options?.cameraLabel) ?? null;

  async function handleCameraChange(option: Option) {
    if (!props.options) return;
    const cameraLabel = !option || !option.isCamera ? null : option.name;

    setLoading(true);
    await props.setOptions
      .mutateAsync({ ...props.options, cameraLabel })
      .finally(() => setLoading(false));

    trackEvent("camera_selected", {
      camera_name: cameraLabel,
      enabled: !!cameraLabel,
    });
  }

  async function showMenu(event: MouseEvent) {
    event.preventDefault();

    if (!permissionGranted()) {
      requestPermission("camera");
      return;
    }

    if (currentRecording.data) return;

    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();

    const menu = await Menu.new({
      items: selectOptions().map((option) => ({
        id: option.name,
        text: option.name,
        type: "checkbox",
        checked:
          option.name === props.options?.cameraLabel ||
          (!option.isCamera && !props.options?.cameraLabel),
        enabled: !loading(),
        action: () => handleCameraChange(option),
      })),
    });

    await menu.popup(
      new LogicalPosition(Math.floor(rect.left), Math.floor(rect.bottom))
    );
  }

  return (
    <div class="flex flex-col gap-[0.25rem] font-medium items-stretch text-[--text-primary]">
      <button
        disabled={loading() || !!currentRecording.data}
        onClick={showMenu}
        class="flex flex-row items-center p-3 gap-[0.375rem] bg-zinc-200 rounded-lg w-full disabled:text-gray-400"
      >
        <IconCapCamera class="text-zinc-400 size-[1.25rem]" />
        <span class="flex-1 text-left truncate">
          {value()?.name ?? "No Camera"}
        </span>
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
      </button>
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
  const [loading, setLoading] = createSignal(false);
  const [dbs, setDbs] = createSignal<number | undefined>();
  const [isInitialized, setIsInitialized] = createSignal(false);

  const requestPermission = useRequestPermission();

  const permissionGranted = () =>
    permissions?.data?.microphone === "granted" ||
    permissions?.data?.microphone === "notNeeded";

  type Option = { name: string; deviceId: string };

  const value = createMemo(() => {
    if (!props.options?.audioInputName) return null;
    return (
      devices.data?.find((d) => d.name === props.options!.audioInputName) ??
      null
    );
  });

  async function handleMicrophoneChange(option: Option) {
    if (!props.options) return;

    setLoading(true);
    await props.setOptions
      .mutateAsync({
        ...props.options,
        audioInputName: option.deviceId !== "" ? option.name : null,
      })
      .finally(() => setLoading(false));

    if (!option.deviceId) setDbs();

    trackEvent("microphone_selected", {
      microphone_name: option.deviceId !== "" ? option.name : null,
      enabled: option.deviceId !== "",
    });
  }

  async function showMenu(event: MouseEvent) {
    event.preventDefault();

    if (!permissionGranted()) {
      requestPermission("microphone");
      return;
    }

    if (currentRecording.data) return;

    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();

    const options = [
      { name: "No Microphone", deviceId: "" },
      ...(devices.data ?? []),
    ];

    const menu = await Menu.new({
      items: options.map((option) => ({
        id: option.deviceId,
        text: option.name,
        type: "checkbox",
        checked:
          option.name === props.options?.audioInputName ||
          (!option.deviceId && !props.options?.audioInputName),
        enabled: !loading(),
        action: () => handleMicrophoneChange(option),
      })),
    });

    await menu.popup(
      new LogicalPosition(Math.floor(rect.left), Math.floor(rect.bottom))
    );
  }

  // Audio level monitoring
  onMount(() => {
    events.audioInputLevelChange.listen((dbs) => {
      if (!props.options?.audioInputName) setDbs();
      else setDbs(dbs.payload);
    });
  });

  const audioLevel = () =>
    Math.pow(1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE, 0.5);

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
      <button
        disabled={loading() || !!currentRecording.data}
        onClick={showMenu}
        class="relative flex flex-row items-center p-3 gap-[0.375rem] bg-zinc-200 rounded-lg w-full disabled:text-gray-400 overflow-hidden z-10"
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
        <IconCapMicrophone class="text-zinc-400 size-[1.25rem]" />
        <span class="flex-1 text-left truncate">
          {value()?.name ?? props.options?.audioInputName ?? "No Microphone"}
        </span>
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
      </button>
    </div>
  );
}

export { CameraSelect, MicrophoneSelect };
