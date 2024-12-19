import { createResource, onCleanup } from "solid-js";

import type { ProjectConfiguration } from "~/utils/tauri";
import { presetsStore, type PresetsStore } from "~/store";

export type CreatePreset = {
  name: string;
  config: Omit<ProjectConfiguration, "timeline">;
  default: boolean;
};

export function createPresets() {
  const [query, queryActions] = createResource(async () => {
    return (await presetsStore.get()) ?? ({ presets: [] } as PresetsStore);
  });

  const [cleanup] = createResource(() =>
    presetsStore.listen((data) => {
      if (data) queryActions.mutate(data);
    })
  );
  onCleanup(() => cleanup()?.());

  async function updatePresets(fn: (prev: PresetsStore) => PresetsStore) {
    const p = query();
    if (!p) throw new Error("Presets not loaded");

    const newValue = fn(p);

    await presetsStore.set(newValue);
  }

  return {
    query,
    createPreset: async (preset: CreatePreset) => {
      let config = { ...preset.config };
      // @ts-ignore we reeeally don't want the timeline in the preset
      config.timeline = undefined;

      await updatePresets((prev) => ({
        presets: [...prev.presets, { name: preset.name, config }],
        default: preset.default ? prev.presets.length : prev.default,
      }));
    },
    deletePreset: (index: number) =>
      updatePresets((prev) => {
        prev.presets.splice(index, 1);

        return {
          presets: prev.presets,
          default:
            index > prev.presets.length - 1
              ? prev.presets.length - 1
              : prev.default,
        };
      }),
    getDefaultConfig: () => {
      const p = query();
      if (!p) return;

      const config = p.presets[p.default ?? 0]?.config;
      // @ts-ignore we reeeally don't want the timeline in the preset
      config.timeline = undefined;
      return config;
    },
    setDefault: (index: number) =>
      updatePresets((prev) => ({
        presets: [...prev.presets],
        default: index,
      })),
    renamePreset: (index: number, name: string) =>
      updatePresets((prev) => {
        prev.presets[index].name = name;

        return prev;
      }),
  };
}
