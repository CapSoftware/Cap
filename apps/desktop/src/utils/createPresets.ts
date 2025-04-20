import type { PresetsStore, ProjectConfiguration } from "~/utils/tauri";
import { presetsStore } from "~/store";
import { produce } from "solid-js/store";

export type CreatePreset = {
  name: string;
  config: Omit<ProjectConfiguration, "timeline">;
  default: boolean;
};

export function createPresets() {
  const query = presetsStore.createQuery();

  async function updatePresets(fn: (prev: PresetsStore) => PresetsStore) {
    if (query.isLoading) throw new Error("Presets not loaded");

    let p = query.data;
    if (!p) await presetsStore.set((p = { presets: [], default: null }));

    const newValue = produce(fn)(p);

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
