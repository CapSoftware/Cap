import { createQuery } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { For, ParentProps, Show, createSignal } from "solid-js";

import Tooltip from "@corvu/tooltip";
import { cx } from "cva";
import { trackEvent } from "~/utils/analytics";
import { commands, events, type RecordingMeta } from "~/utils/tauri";

type MediaEntry = {
  id: string;
  path: string;
  prettyName: string;
  isNew: boolean;
  thumbnailPath: string;
};

const Modes = [
  {
    id: "instant",
    icon: <IconCapInstant class="invert size-4 dark:invert-0" />,
    label: "Instant Mode",
  },
  {
    id: "studio",
    icon: <IconCapFilmCut class="invert size-4 dark:invert-0" />,
    label: "Studio Mode",
  },
] as const;

export default function Recordings() {
  const [activeTab, setActiveTab] = createSignal<(typeof Modes)[number]["id"]>(
    Modes[0].id
  );
  const fetchRecordings = createQuery(() => ({
    queryKey: ["recordings"],
    queryFn: async () => {
      const result = await commands
        .listRecordings()
        .catch(() => [] as [string, string, RecordingMeta][]);

      const recordings = await Promise.all(
        result.map(async (file) => {
          const [id, path, meta] = file;
          const thumbnailPath = `${path}/screenshots/display.jpg`;

          return {
            id,
            path,
            prettyName: meta.pretty_name,
            isNew: false,
            thumbnailPath,
          };
        })
      );
      return recordings;
    },
  }));

  const handleRecordingClick = (recording: MediaEntry) => {
    trackEvent("recording_view_clicked", { recording_id: recording.id });
    events.newStudioRecordingAdded.emit({ path: recording.path });
  };

  const handleOpenFolder = (path: string) => {
    trackEvent("recording_folder_clicked", { path });
    commands.openFilePath(path);
  };

  const handleOpenEditor = (id: string) => {
    const normalizedPath = id.replace(/\\/g, "/");
    const fileName = normalizedPath.split("/").pop() || "";
    trackEvent("recording_editor_clicked", {
      recording_id: fileName.replace(".cap", ""),
    });
    commands.openEditor(fileName.replace(".cap", ""));
  };

  return (
    <>
      <div class="flex gap-4 p-4 text-gray-500 border-b border-gray-200 border-dashed">
        <For each={Modes}>
          {(mode) => (
            <div
              onClick={() => setActiveTab(mode.id)}
              class={cx(
                "flex flex-1 gap-3 justify-center items-center p-3 rounded-xl duration-300 transition-all",
                activeTab() === mode.id
                  ? "ring-2 ring-blue-300 ring-offset-2 ring-offset-gray-100 cursor-default bg-gray-200"
                  : "cursor-pointer bg-gray-100 hover:bg-gray-200"
              )}
            >
              {mode.icon}
              <p class="font-medium">{mode.label}</p>
            </div>
          )}
        </For>
      </div>
      <div class="flex flex-col pb-12 w-full">
        <div class="overflow-y-auto flex-1">
          <ul class="p-[0.625rem] flex flex-col gap-[0.5rem] w-full text-[--text-primary]">
            <Show
              when={fetchRecordings.data && fetchRecordings.data.length > 0}
              fallback={
                <p class="text-center text-[--text-tertiary]">
                  No recordings found
                </p>
              }
            >
              <For each={fetchRecordings.data}>
                {(recording) => (
                  <RecordingItem
                    recording={recording}
                    onClick={() => handleRecordingClick(recording)}
                    onOpenFolder={() => handleOpenFolder(recording.path)}
                    onOpenEditor={() => handleOpenEditor(recording.path)}
                  />
                )}
              </For>
            </Show>
          </ul>
        </div>
      </div>
    </>
  );
}

function RecordingItem(props: {
  recording: MediaEntry;
  onClick: () => void;
  onOpenFolder: () => void;
  onOpenEditor: () => void;
}) {
  const [imageExists, setImageExists] = createSignal(true);

  return (
    <li class="flex flex-row justify-between items-center px-4 py-3 w-full rounded-xl transition-colors duration-200 hover:bg-gray-100">
      <div class="flex items-center">
        <Show
          when={imageExists()}
          fallback={<div class="mr-4 w-8 h-8 bg-gray-400 rounded" />}
        >
          <img
            class="object-cover mr-4 w-8 h-8 rounded"
            alt="Recording thumbnail"
            src={`${convertFileSrc(
              props.recording.thumbnailPath
            )}?t=${Date.now()}`}
            onError={() => setImageExists(false)}
          />
        </Show>
        <span>{props.recording.prettyName}</span>
      </div>
      <div class="flex items-center">
        <TooltipIconButton
          tooltipText="Open project files"
          onClick={() => props.onOpenFolder()}
        >
          <IconLucideFolder class="size-4" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltipText="Open in editor"
          onClick={() => props.onOpenEditor()}
        >
          <IconLucideEdit class="size-4" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltipText="Show in recordings overlay"
          onClick={() => props.onClick()}
        >
          <IconLucideEye class="size-4" />
        </TooltipIconButton>
      </div>
    </li>
  );
}

function TooltipIconButton(
  props: ParentProps<{ onClick: () => void; tooltipText: string }>
) {
  return (
    <Tooltip>
      <Tooltip.Trigger
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          props.onClick();
        }}
        class="p-2.5 mr-2 opacity-70 hover:opacity-100 rounded-full transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-300"
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="py-2 px-3 font-medium bg-gray-100 text-gray-500 border border-gray-200 text-xs rounded-lg animate-in fade-in slide-in-from-top-0.5">
          {props.tooltipText}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}
