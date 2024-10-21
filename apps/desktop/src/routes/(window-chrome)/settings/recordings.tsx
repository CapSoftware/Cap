import { createQuery } from "@tanstack/solid-query";
import { For, Show, createSignal } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";

import { commands, events } from "~/utils/tauri";

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
      try {
        const result = await commands.listRecordings();
        if (result.status === "ok") {
          const recordings = await Promise.all(
            result.data.map(async (file) => {
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
        } else {
          console.error("Failed to list recordings:", result.error);
          return [];
        }
      } catch (error) {
        console.error("Error fetching recordings:", error);
        return [];
      }
    },
  }));

  const handleRecordingClick = (recording: MediaEntry) => {
    events.newRecordingAdded.emit({ path: recording.path });
  };

  const handleOpenFolder = (path: string) => {
    commands.openFilePath(path);
  };

  const handleOpenEditor = (id: string) => {
    const normalizedPath = id.replace(/\\/g, "/");
    const fileName = normalizedPath.split("/").pop() || "";
    commands.openEditor(fileName.replace(".cap", ""));
  };

  return (
    <div class="flex flex-col w-full h-full divide-y divide-gray-200 pt-1 pb-12">
      <div class="flex-1 overflow-y-auto">
        <Show
          when={!fetchRecordings.isLoading}
          fallback={
            <p class="text-center text-gray-500">Loading recordings...</p>
          }
        >
          <ul class="p-[0.625rem] flex flex-col gap-[0.5rem] w-full">
            <Show
              when={fetchRecordings.data && fetchRecordings.data.length > 0}
              fallback={
                <p class="text-center text-gray-500">No recordings found</p>
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
        </Show>
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
