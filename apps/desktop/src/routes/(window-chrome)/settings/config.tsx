import { createQuery } from "@tanstack/solid-query";
import { For, Show } from "solid-js";
import { commands } from "~/utils/tauri";

const RESOLUTION_OPTIONS = [
  { label: "720p (1280x720)", value: "720p", width: 1280, height: 720 },
  { label: "1080p (1920x1080)", value: "1080p", width: 1920, height: 1080 },
  { label: "4K (3840x2160)", value: "4k", width: 3840, height: 2160 },
] as const;

const FPS_OPTIONS = [
  { label: "30 FPS", value: 30 },
  { label: "60 FPS", value: 60 },
] as const;

export default function Config() {
  const config = createQuery(() => ({
    queryKey: ["recording-config"],
    queryFn: () => commands.getRecordingOptions(),
  }));

  const updateConfig = async (updates: {
    fps?: number;
    outputResolution?: { width: number; height: number };
  }) => {
    if (!config.data) return;

    await commands.setRecordingOptions({
      ...config.data,
      ...updates,
    });

    config.refetch();
  };

  return (
    <div class="flex flex-col w-full h-full divide-y divide-[--gray-200] pt-1 pb-12">
      <div class="p-4">
        <div class="mb-6">
          <label class="text-sm font-medium mb-2 block">
            Output Resolution
          </label>
          <select
            class="w-full p-2 border rounded"
            value={
              RESOLUTION_OPTIONS.find(
                (opt) =>
                  opt.width === config.data?.outputResolution?.width &&
                  opt.height === config.data?.outputResolution?.height
              )?.value
            }
            onChange={(e) => {
              const option = RESOLUTION_OPTIONS.find(
                (opt) => opt.value === e.currentTarget.value
              );
              if (option) {
                updateConfig({
                  outputResolution: {
                    width: option.width,
                    height: option.height,
                  },
                });
              }
            }}
          >
            <For each={RESOLUTION_OPTIONS}>
              {(option) => <option value={option.value}>{option.label}</option>}
            </For>
          </select>
        </div>

        <div class="mb-6">
          <label class="text-sm font-medium mb-2 block">Frame Rate</label>
          <select
            class="w-full p-2 border rounded"
            value={config.data?.fps}
            onChange={(e) => {
              updateConfig({ fps: Number(e.currentTarget.value) });
            }}
          >
            <For each={FPS_OPTIONS}>
              {(option) => <option value={option.value}>{option.label}</option>}
            </For>
          </select>
        </div>
      </div>
    </div>
  );
}
