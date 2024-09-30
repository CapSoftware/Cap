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

export default function Screenshots() {
  const fetchScreenshots = createQuery(() => ({
    queryKey: ["screenshots"],
    queryFn: async () => {
      const result = await commands.listScreenshots();
      if (result.status === "ok") {
        const screenshots = await Promise.all(
          result.data.map(async (file) => {
            const [id, pngPath, meta] = file;

            return {
              id,
              path: pngPath,
              prettyName: meta.pretty_name,
              isNew: false,
              thumbnailPath: pngPath,
            };
          })
        );
        return screenshots;
      } else {
        return [];
      }
    },
  }));

  const handleScreenshotClick = (screenshot: MediaEntry) => {
    events.newScreenshotAdded.emit({ path: screenshot.path });
  };

  const handleOpenFolder = (path: string) => {
    commands.openFilePath(path);
  };

  return (
    <div class="flex flex-col w-full h-full divide-y divide-gray-200 pt-1 pb-12">
      <div class="flex-1 overflow-y-auto">
        <Show
          when={!fetchScreenshots.isLoading}
          fallback={
            <p class="text-center text-gray-500">Loading screenshots...</p>
          }
        >
          <ul class="p-[0.625rem] flex flex-col gap-[0.5rem] w-full">
            <Show
              when={fetchScreenshots.data && fetchScreenshots.data.length > 0}
              fallback={
                <p class="text-center text-gray-500">No screenshots found</p>
              }
            >
              <For each={fetchScreenshots.data}>
                {(screenshot) => (
                  <ScreenshotItem
                    screenshot={screenshot}
                    onClick={() => handleScreenshotClick(screenshot)}
                    onOpenFolder={() => handleOpenFolder(screenshot.path)}
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

function ScreenshotItem(props: {
  screenshot: MediaEntry;
  onClick: () => void;
  onOpenFolder: () => void;
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
            alt="Screenshot thumbnail"
            src={`${convertFileSrc(
              props.screenshot.thumbnailPath
            )}?t=${Date.now()}`}
            onError={() => setImageExists(false)}
          />
        </Show>
        <span>{props.screenshot.prettyName}</span>
      </div>
      <div class="flex items-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenFolder();
          }}
          class="p-2 hover:bg-gray-200 rounded-full mr-2"
        >
          <IconLucideFolder size={20} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onClick();
          }}
          class="p-2 hover:bg-gray-200 rounded-full"
        >
          <IconLucideEye size={20} />
        </button>
      </div>
    </li>
  );
}
