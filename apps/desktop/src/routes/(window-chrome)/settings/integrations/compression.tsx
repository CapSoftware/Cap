import { Button } from "@cap/ui-solid";
import { createWritableMemo } from "@solid-primitives/memo";
import { useMutation } from "@tanstack/solid-query";
import { createResource, Show, Suspense } from "solid-js";
import { createEventBus } from "@solid-primitives/event-bus";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import { commands } from "~/utils/tauri";
import { Toggle } from "~/components/Toggle";

interface CompressionConfig {
  enabled: boolean;
  quality: "high" | "medium" | "low";
  preset: "slow" | "medium" | "fast";
  audioBitrate: number;
  deleteOriginal: boolean;
}

const DEFAULT_CONFIG: CompressionConfig = {
  enabled: false,
  quality: "high",
  preset: "slow",
  audioBitrate: 128,
  deleteOriginal: false,
};

export default function CompressionConfigPage() {
  const [store] = createResource(() => generalSettingsStore.get());

  return (
    <Show when={store.state === "ready" && ([store()] as const)}>
      {(store) => <Inner initialStore={store()[0] ?? null} />}
    </Show>
  );
}

function Inner(props: { initialStore: any }) {
  const [compressionConfig, setCompressionConfig] =
    createStore<CompressionConfig>(
      props.initialStore?.compressionConfig ?? DEFAULT_CONFIG
    );

  const handleChange = async (updates: Partial<CompressionConfig>) => {
    const newConfig = { ...compressionConfig, ...updates };
    setCompressionConfig(newConfig);
    await generalSettingsStore.set({ compressionConfig: newConfig });
  };

  const events = createEventBus<"save" | "reset">();

  const qualityOptions = [
    {
      value: "high",
      label: "High Quality",
      description: "CRF 23, larger file size",
    },
    {
      value: "medium",
      label: "Medium Quality",
      description: "CRF 28, balanced",
    },
    {
      value: "low",
      label: "Low Quality",
      description: "CRF 35, smaller file size",
    },
  ];

  const presetOptions = [
    {
      value: "slow",
      label: "Slow",
      description: "Better compression, slower export",
    },
    {
      value: "medium",
      label: "Medium",
      description: "Balanced speed and compression",
    },
    {
      value: "fast",
      label: "Fast",
      description: "Faster export, larger file size",
    },
  ];

  events.listen(async (v) => {
    if (v === "save") {
      await generalSettingsStore.set({ compressionConfig });
      await commands.globalMessageDialog(
        "Compression settings saved successfully"
      );
    } else if (v === "reset") {
      setCompressionConfig(DEFAULT_CONFIG);
      await generalSettingsStore.set({ compressionConfig: DEFAULT_CONFIG });
      await commands.globalMessageDialog(
        "Compression settings reset successfully"
      );
    }
  });

  return (
    <div class="flex flex-col h-full">
      <div class="overflow-y-auto flex-1 p-4">
        <div class="space-y-4 animate-in fade-in">
          <div>
            <p class="text-sm text-gray-11">
              Enable automatic compression for exported videos. This will
              re-encode your videos after export to reduce file size while
              maintaining quality.
            </p>
          </div>

          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <label class="text-sm text-gray-12">Enable Compression</label>
                <p class="text-xs text-gray-11">
                  Automatically compress videos after export
                </p>
              </div>
              <Toggle
                checked={compressionConfig.enabled}
                onChange={(checked) => handleChange({ enabled: checked })}
              />
            </div>

            <Show when={compressionConfig.enabled}>
              <div>
                <label class="text-sm text-gray-12">Quality</label>
                <div class="mt-2 space-y-2">
                  {qualityOptions.map((option) => (
                    <label class="flex items-start gap-3 p-3 rounded-lg border border-gray-3 hover:bg-gray-2 cursor-pointer transition-colors">
                      <input
                        type="radio"
                        name="quality"
                        value={option.value}
                        checked={compressionConfig.quality === option.value}
                        onChange={() =>
                          handleChange({ quality: option.value as any })
                        }
                        class="mt-0.5"
                      />
                      <div class="flex-1">
                        <div class="text-sm text-gray-12">{option.label}</div>
                        <div class="text-xs text-gray-11">
                          {option.description}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label class="text-sm text-gray-12">Encoding Speed</label>
                <div class="mt-2 space-y-2">
                  {presetOptions.map((option) => (
                    <label class="flex items-start gap-3 p-3 rounded-lg border border-gray-3 hover:bg-gray-2 cursor-pointer transition-colors">
                      <input
                        type="radio"
                        name="preset"
                        value={option.value}
                        checked={compressionConfig.preset === option.value}
                        onChange={() =>
                          handleChange({ preset: option.value as any })
                        }
                        class="mt-0.5"
                      />
                      <div class="flex-1">
                        <div class="text-sm text-gray-12">{option.label}</div>
                        <div class="text-xs text-gray-11">
                          {option.description}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label class="text-sm text-gray-12">Audio Bitrate (kbps)</label>
                <input
                  type="number"
                  min="64"
                  max="320"
                  step="32"
                  value={compressionConfig.audioBitrate}
                  onInput={(e) =>
                    handleChange({
                      audioBitrate: parseInt(e.currentTarget.value) || 128,
                    })
                  }
                  class="mt-2 px-3 py-2 w-full rounded-lg bg-gray-1 border border-gray-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p class="mt-1 text-xs text-gray-11">
                  Higher values mean better audio quality but larger file size
                </p>
              </div>

              <div class="flex items-center justify-between">
                <div>
                  <label class="text-sm text-gray-12">Delete Original</label>
                  <p class="text-xs text-gray-11">
                    Remove the original file after compression succeeds
                  </p>
                </div>
                <Toggle
                  checked={compressionConfig.deleteOriginal}
                  onChange={(checked) =>
                    handleChange({ deleteOriginal: checked })
                  }
                />
              </div>
            </Show>
          </div>
        </div>
      </div>

      <div class="flex-shrink-0 p-4 border-t">
        <fieldset class="flex justify-between items-center">
          <div class="flex gap-2">
            <Button variant="destructive" onClick={() => events.emit("reset")}>
              Reset to Default
            </Button>
          </div>
          <Button variant="primary" onClick={() => events.emit("save")}>
            Save
          </Button>
        </fieldset>
      </div>
    </div>
  );
}
