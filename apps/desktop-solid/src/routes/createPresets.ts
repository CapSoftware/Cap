import { createResource, onCleanup } from "solid-js";
import { Store } from "@tauri-apps/plugin-store";

import type { ProjectConfiguration } from "../utils/tauri";

const store = new Store("frontend-stuff");

type PresetsStore = {
  presets: Array<{
    name: string;
    config: ProjectConfiguration;
  }>;
  default?: number;
};

export type CreatePreset = {
  name: string;
  config: ProjectConfiguration;
  default: boolean;
};

export function createPresets() {
  const [query, queryActions] = createResource(async () => {
    return (
      (await store.get<PresetsStore>("presets")) ??
      ({ presets: [] } as PresetsStore)
    );
  });

  const [cleanup] = createResource(() =>
    store.onKeyChange<PresetsStore>("presets", (data) => {
      if (data) queryActions.mutate(data);
    })
  );
  onCleanup(() => cleanup()?.());

  async function updatePresets(fn: (prev: PresetsStore) => PresetsStore) {
    const p = query();
    if (!p) throw new Error("Presets not loaded");

    const newValue = fn(p);

    await store.set("presets", newValue);
    await store.save();
  }

  return {
    query,
    createPreset: (preset: CreatePreset) =>
      updatePresets((prev) => ({
        presets: [
          ...prev.presets,
          { name: preset.name, config: preset.config },
        ],
        default: preset.default ? prev.presets.length : prev.default,
      })),
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

      return p.presets[p.default ?? 0].config;
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
