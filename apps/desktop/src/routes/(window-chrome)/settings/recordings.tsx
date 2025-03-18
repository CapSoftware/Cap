import { createQuery } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { createSignal, For, ParentProps, Show } from "solid-js";

import Tooltip from "@corvu/tooltip";
import { trackEvent } from "~/utils/analytics";
import { commands, events, RecordingMetaWithType } from "~/utils/tauri";

type Recording = {
  meta: RecordingMetaWithType;
  id: string;
  path: string;
  prettyName: string;
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
  const recordings = createQuery(() => ({
    queryKey: ["recordings"],
    queryFn: async () => {
      const result = await commands.listRecordings().catch(() => [] as const);

      const recordings = await Promise.all(
        result.map(async (file) => {
          const [id, path, meta] = file;
          const thumbnailPath = `${path}/screenshots/display.jpg`;

          return {
            meta,
            id,
            path,
            prettyName: meta.pretty_name,
            thumbnailPath,
          };
        })
      );
      return recordings;
    },
  }));

  const handleRecordingClick = (recording: Recording) => {
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
    <div class="flex flex-col pb-12 w-full">
      <div class="overflow-y-auto flex-1">
        <ul class="p-[0.625rem] flex flex-col gap-[0.5rem] w-full text-[--text-primary]">
          <Show
            when={recordings.data && recordings.data.length > 0}
            fallback={
              <p class="text-center text-[--text-tertiary]">
                No recordings found
              </p>
            }
          >
            <For each={recordings.data}>
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
  );
}

function RecordingItem(props: {
  recording: Recording;
  onClick: () => void;
  onOpenFolder: () => void;
  onOpenEditor: () => void;
}) {
  const [imageExists, setImageExists] = createSignal(true);

  return (
    <li class="flex flex-row justify-between items-center px-4 py-3 w-full rounded-xl transition-colors duration-200 hover:bg-gray-100">
      <div class="flex gap-5 items-center">
        <Show
          when={imageExists()}
          fallback={<div class="mr-4 bg-gray-400 rounded size-11" />}
        >
          <img
            class="object-cover rounded size-12"
            alt="Recording thumbnail"
            src={`${convertFileSrc(
              props.recording.thumbnailPath
            )}?t=${Date.now()}`}
            onError={() => setImageExists(false)}
          />
        </Show>
        <div class="flex flex-col gap-2">
          <span>{props.recording.prettyName}</span>
          {/** Tag */}
          <div class="px-2 py-0.5 flex items-center gap-1 font-medium text-[11px] text-gray-500 bg-blue-100 rounded-full w-fit">
            <IconCapInstant class="invert size-2.5 dark:invert-0" />
            <p>Instant mode</p>
          </div>
        </div>
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
