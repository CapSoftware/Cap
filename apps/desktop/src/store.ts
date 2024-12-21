import { Store } from "@tauri-apps/plugin-store";

import {
  type AuthStore,
  type ProjectConfiguration,
  type HotkeysStore,
  type GeneralSettingsStore,
} from "~/utils/tauri";

let _store: Promise<Store> | undefined;
const store = () => {
  if (!_store) {
    _store = Store.load("store");
  }

  return _store;
};

export type PresetsStore = {
  presets: Array<{
    name: string;
    config: Omit<ProjectConfiguration, "timeline">;
  }>;
  default?: number;
};

export const presetsStore = {
  get: () => store().then((s) => s.get<PresetsStore>("presets")),
  set: async (value: PresetsStore) => {
    const s = await store();
    await s.set("presets", value);
    await s.save();
  },
  listen: (fn: (data?: PresetsStore | undefined) => void) =>
    store().then((s) => s.onKeyChange<PresetsStore>("presets", fn)),
};

export const authStore = {
  get: () => store().then((s) => s.get<AuthStore>("auth")),
  set: async (value?: AuthStore | undefined) => {
    const s = await store();
    await s.set("auth", value);
    await s.save();
  },
  listen: (fn: (data?: AuthStore | undefined) => void) =>
    store().then((s) => s.onKeyChange<AuthStore>("presets", fn)),
};

export const hotkeysStore = {
  get: () => store().then((s) => s.get<HotkeysStore>("hotkeys")),
  set: async (value: HotkeysStore) => {
    const s = await store();
    await s.set("hotkeys", value);
    await s.save();
  },
};

export const generalSettingsStore = {
  get: () =>
    store().then((s) => s.get<GeneralSettingsStore>("general_settings")),
  set: async (value: Partial<GeneralSettingsStore>) => {
    const s = await store();
    const current =
      (await s.get<GeneralSettingsStore>("general_settings")) || {};
    await s.set("general_settings", {
      ...current,
      ...value,
    });
    await s.save();
  },
  listen: (fn: (data?: GeneralSettingsStore | undefined) => void) =>
    store().then((s) =>
      s.onKeyChange<GeneralSettingsStore>("general_settings", fn)
    ),
};
