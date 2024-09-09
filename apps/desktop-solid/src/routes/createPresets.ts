import { createResource, onCleanup } from "solid-js";

import type { ProjectConfiguration } from "../utils/tauri";
import { Store } from "@tauri-apps/plugin-store";

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

  return {
    query,
    createPreset: async (preset: CreatePreset) => {
      const p = query();
      if (!p) throw new Error("Presets not loaded");

      await store.set("presets", {
        presets: [...p.presets, { name: preset.name, config: preset.config }],
        default: preset.default ? p.presets.length : p.default,
      });
    },
    deletePreset: async (index: number) => {
      const p = query();
      if (!p) throw new Error("Presets not loaded");

      p.presets.splice(index, 1);

      await store.set("presets", {
        presets: p.presets,
        default:
          index > p.presets.length - 1 ? p.presets.length - 1 : p.default,
      });
    },
    getDefaultConfig: () => {
      const p = query();
      if (!p) return;

      return p.presets[p.default ?? 0].config;
    },
    setDefault: async (index: number) => {
      const p = query();
      if (!p) throw new Error("Presets not loaded");

      await store.set("presets", {
        presets: [...p.presets],
        default: index,
      });
    },
    renamePreset: async (index: number, name: string) => {
      const p = query();
      if (!p) throw new Error("Presets not loaded");

      p.presets[index].name = name;

      await store.set("presets", {
        presets: p.presets,
        default: p.default,
      });
    },
  };
}
