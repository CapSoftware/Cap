import { Store } from "@tauri-apps/plugin-store";

import type { AuthStore, ProjectConfiguration } from "./utils/tauri";

const store = new Store("store");

export type PresetsStore = {
  presets: Array<{
    name: string;
    config: ProjectConfiguration;
  }>;
  default?: number;
};

export const presetsStore = {
  get: () => store.get<PresetsStore>("presets"),
  set: async (value: PresetsStore) => {
    await store.set("presets", value);
    await store.save();
  },
  listen: (fn: (data: PresetsStore | null) => void) =>
    store.onKeyChange<PresetsStore>("presets", fn),
};

export const authStore = {
  get: () => store.get<AuthStore>("auth"),
  set: async (value: AuthStore | null) => {
    await store.set("auth", value);
    await store.save();
  },
  listen: (fn: (data: AuthStore | null) => void) =>
    store.onKeyChange<AuthStore>("presets", fn),
};
