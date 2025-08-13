import { createQuery } from "@tanstack/solid-query";
import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { createCurrentRecordingQuery, getPermissions } from "~/utils/queries";
import TargetSelectInfoPill from "./TargetSelectInfoPill";
import useRequestPermission from "./useRequestPermission";
import { trackEvent } from "~/utils/analytics";
import { events } from "~/utils/tauri";

const NO_MICROPHONE = "No Microphone";

export default function MicrophoneSelect(props: {
  disabled?: boolean;
  options: string[];
  value: string | null;
  onChange: (micName: string | null) => void;
}) {
  const DB_SCALE = 40;

  const permissions = createQuery(() => getPermissions);
  const currentRecording = createCurrentRecordingQuery();

  const [dbs, setDbs] = createSignal<number | undefined>();
  const [isInitialized, setIsInitialized] = createSignal(false);

  const requestPermission = useRequestPermission();

  const permissionGranted = () =>
    permissions?.data?.microphone === "granted" ||
    permissions?.data?.microphone === "notNeeded";

  type Option = { name: string };

  const handleMicrophoneChange = async (item: Option | null) => {
    if (!props.options) return;
    props.onChange(item ? item.name : null);
    if (!item) setDbs();

    trackEvent("microphone_selected", {
      microphone_name: item?.name ?? null,
      enabled: !!item,
    });
  };

  const result = events.audioInputLevelChange.listen((dbs) => {
    if (!props.value) setDbs();
    else setDbs(dbs.payload);
  });

  onCleanup(() => result.then((unsub) => unsub()));

  // visual audio level from 0 -> 1
  const audioLevel = () =>
    Math.pow(1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE, 0.5);

  // Initialize audio input if needed - only once when component mounts
  onMount(() => {
    if (!props.value || !permissionGranted() || isInitialized()) return;

    setIsInitialized(true);
  });

  return (
    <div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      <button
        disabled={!!currentRecording.data || props.disabled}
        class="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg transition-colors hover:bg-gray-3 bg-gray-2 disabled:text-gray-11 KSelect"
        onClick={() => {
          Promise.all([
            CheckMenuItem.new({
              text: NO_MICROPHONE,
              checked: props.value === null,
              action: () => handleMicrophoneChange(null),
            }),
            PredefinedMenuItem.new({ item: "Separator" }),
            ...(props.options ?? []).map((name) =>
              CheckMenuItem.new({
                text: name,
                checked: name === props.value,
                action: () => handleMicrophoneChange({ name: name }),
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
        <IconCapMicrophone class="text-gray-10 size-4" />
        <p class="flex-1 text-sm text-left truncate">
          {props.value ?? NO_MICROPHONE}
        </p>
        <TargetSelectInfoPill
          value={props.value}
          permissionGranted={permissionGranted()}
          requestPermission={() => requestPermission("microphone")}
          onClick={(e) => {
            if (props.value !== null) {
              e.stopPropagation();
              props.onChange(null);
            }
          }}
        />
      </button>
    </div>
  );
}
