import { Select as KSelect } from "@kobalte/core/select";
import { createQuery } from "@tanstack/solid-query";
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
import {
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
} from "../../editor/ui";

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
             gap-[0.375rem] bg-zinc-200 rounded-lg w-full disabled:text-gray-400 KSelect"
        >
          <IconCapCamera class="text-zinc-400 size-[1.25rem]" />
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
             bg-zinc-200 rounded-lg w-full disabled:text-gray-400 KSelect overflow-hidden z-10"
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

export { CameraSelect, MicrophoneSelect };
