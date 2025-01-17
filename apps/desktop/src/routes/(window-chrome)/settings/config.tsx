import { createQuery } from "@tanstack/solid-query";
import { For, Show } from "solid-js";
import { commands } from "~/utils/tauri";
import { Select as KSelect } from "@kobalte/core/select";
import { cx } from "cva";
import {
  MenuItem,
  MenuItemList,
  PopperContent,
  topLeftAnimateClasses,
} from "~/routes/editor/ui";

type ResolutionOption = {
  label: string;
  value: string;
  width: number;
  height: number;
};

type FpsOption = {
  label: string;
  value: number;
};

const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { label: "720p", value: "720p", width: 1280, height: 720 },
  { label: "1080p", value: "1080p", width: 1920, height: 1080 },
  { label: "4K", value: "4k", width: 3840, height: 2160 },
];

const FPS_OPTIONS: FpsOption[] = [
  { label: "30 FPS", value: 30 },
  { label: "60 FPS", value: 60 },
];

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
          <label class="text-sm font-medium mb-2 block text-gray-500 dark:text-gray-400">
            Output Resolution
          </label>
          <KSelect<(typeof RESOLUTION_OPTIONS)[number]>
            options={RESOLUTION_OPTIONS}
            optionValue="value"
            optionTextValue="label"
            placeholder="Select Resolution"
            value={RESOLUTION_OPTIONS.find(
              (opt) =>
                opt.width === config.data?.outputResolution?.width &&
                opt.height === config.data?.outputResolution?.height
            )}
            onChange={(option) => {
              if (option) {
                updateConfig({
                  outputResolution: {
                    width: option.width,
                    height: option.height,
                  },
                });
              }
            }}
            itemComponent={(props) => (
              <MenuItem<typeof KSelect.Item>
                as={KSelect.Item}
                item={props.item}
              >
                <KSelect.ItemLabel class="flex-1">
                  {props.item.rawValue.label}
                </KSelect.ItemLabel>
              </MenuItem>
            )}
          >
            <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect">
              <KSelect.Value<
                (typeof RESOLUTION_OPTIONS)[number]
              > class="flex-1 text-sm text-left truncate text-[--gray-500]">
                {(state) => <span>{state.selectedOption()?.label}</span>}
              </KSelect.Value>
              <KSelect.Icon>
                <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]" />
              </KSelect.Icon>
            </KSelect.Trigger>
            <KSelect.Portal>
              <PopperContent<typeof KSelect.Content>
                as={KSelect.Content}
                class={cx(topLeftAnimateClasses, "z-50")}
              >
                <MenuItemList<typeof KSelect.Listbox>
                  class="max-h-32 overflow-y-auto"
                  as={KSelect.Listbox}
                />
              </PopperContent>
            </KSelect.Portal>
          </KSelect>
        </div>

        <div class="mb-6">
          <label class="text-sm font-medium mb-2 block text-gray-500 dark:text-gray-400">
            Frame Rate
          </label>
          <KSelect<(typeof FPS_OPTIONS)[number]>
            options={FPS_OPTIONS}
            optionValue="value"
            optionTextValue="label"
            placeholder="Select FPS"
            value={FPS_OPTIONS.find((opt) => opt.value === config.data?.fps)}
            onChange={(option) => {
              if (option) {
                updateConfig({ fps: option.value });
              }
            }}
            itemComponent={(props) => (
              <MenuItem<typeof KSelect.Item>
                as={KSelect.Item}
                item={props.item}
              >
                <KSelect.ItemLabel class="flex-1">
                  {props.item.rawValue.label}
                </KSelect.ItemLabel>
              </MenuItem>
            )}
          >
            <KSelect.Trigger class="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-200 w-full disabled:text-gray-400 transition-colors KSelect">
              <KSelect.Value<
                (typeof FPS_OPTIONS)[number]
              > class="flex-1 text-sm text-left truncate text-[--gray-500]">
                {(state) => <span>{state.selectedOption()?.label}</span>}
              </KSelect.Value>
              <KSelect.Icon>
                <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]" />
              </KSelect.Icon>
            </KSelect.Trigger>
            <KSelect.Portal>
              <PopperContent<typeof KSelect.Content>
                as={KSelect.Content}
                class={cx(topLeftAnimateClasses, "z-50")}
              >
                <MenuItemList<typeof KSelect.Listbox>
                  class="max-h-32 overflow-y-auto"
                  as={KSelect.Listbox}
                />
              </PopperContent>
            </KSelect.Portal>
          </KSelect>
        </div>
      </div>
    </div>
  );
}
