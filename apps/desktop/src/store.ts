import { createQuery } from "@tanstack/solid-query";
import { Store } from "@tauri-apps/plugin-store";
import { onCleanup } from "solid-js";

import type {
	AuthStore,
	GeneralSettingsStore,
	HotkeysStore,
	PresetsStore,
	RecordingSettingsStore,
} from "~/utils/tauri";

let _store: Promise<Store> | undefined;
const store = () => {
	if (!_store) {
		_store = Store.load("store");
	}

	return _store;
};

function declareStore<T extends object>(name: string) {
	const get = () => store().then((s) => s.get<T>(name));
	const listen = (fn: (data?: T | undefined) => void) =>
		store().then((s) => s.onKeyChange<T>(name, fn));

	return {
		get,
		listen,
		set: async (value?: Partial<T>) => {
			const s = await store();
			if (value === undefined) s.delete(name);
			else {
				const current = (await s.get<T>(name)) || {};
				await s.set(name, {
					...current,
					...value,
				});
			}
			await s.save();
		},
		createQuery: () => {
			const query = createQuery(() => ({
				queryKey: ["store", name],
				queryFn: async () => (await get()) ?? null,
			}));

			const cleanup = listen(() => {
				query.refetch();
			});
			onCleanup(() => cleanup.then((c) => c()));

			return query;
		},
	};
}

export const presetsStore = declareStore<PresetsStore>("presets");
export const authStore = declareStore<AuthStore>("auth");
export const hotkeysStore = declareStore<HotkeysStore>("hotkeys");
export const generalSettingsStore =
	declareStore<GeneralSettingsStore>("general_settings");
export const recordingSettingsStore =
	declareStore<RecordingSettingsStore>("recording_settings");
