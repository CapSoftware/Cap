import { createQuery } from "@tanstack/solid-query";
import { For, Show, Suspense, createSignal } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";

import { commands, events, type RecordingMeta } from "~/utils/tauri";
import { trackEvent } from "~/utils/analytics";

type MediaEntry = {
  id: string;
  path: string;
  prettyName: string;
  isNew: boolean;
  thumbnailPath: string;
};

export default function Recordings() {
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
    events.newRecordingAdded.emit({ path: recording.path });
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
    <div class="flex flex-col w-full h-full divide-y divide-[--gray-200] pt-1 pb-12">
      <div class="flex-1 overflow-y-auto">
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
    <li class="w-full flex flex-row justify-between items-center p-2 hover:bg-gray-100 rounded">
      <div class="flex items-center">
        <Show
          when={imageExists()}
          fallback={<div class="w-8 h-8 bg-gray-400 mr-4 rounded" />}
        >
          <img
            class="w-8 h-8 object-cover mr-4 rounded"
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
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenFolder();
          }}
          class="p-2 hover:bg-gray-200 rounded-full mr-2"
        >
          <IconLucideFolder class="size-5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenEditor();
          }}
          class="p-2 hover:bg-gray-200 rounded-full mr-2"
        >
          <IconLucideEdit class="size-5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onClick();
          }}
          class="p-2 hover:bg-gray-200 rounded-full"
        >
          <IconLucideEye class="size-5" />
        </button>
      </div>
    </li>
  );
}
