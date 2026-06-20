import { createQuery } from "@tanstack/solid-query";
import { Store } from "@tauri-apps/plugin-store";
import { onCleanup } from "solid-js";
import type { AutomationsStore } from "~/utils/automations";
import type { GeneralSettingsStore } from "~/utils/general-settings";
import type {
	AuthStore,
	HotkeysStore,
	PresetsStore,
	RecordingSettingsStore,
} from "~/utils/tauri";

export type UserProfileStore = {
	userId: string | null;
	profile: {
		name: string | null;
		email: string | null;
		imageUrl: string | null;
	};
	updatedAt: number;
};

let _store: Promise<Store> | undefined;
const store = () => {
	if (!_store) {
		_store = Store.load("store");
	}

	return _store;
};

function declareStore<T extends object>(name: string, defaults?: T) {
	const withDefaults = (value?: T) =>
		defaults ? { ...defaults, ...(value ?? {}) } : value;
	const get = async () => {
		const s = await store();
		return withDefaults(await s.get<T>(name));
	};
	const listen = (fn: (data?: T | undefined) => void) =>
		store().then((s) =>
			s.onKeyChange<T>(name, (data) => fn(withDefaults(data))),
		);

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
export const automationsStore = declareStore<AutomationsStore>("automations");
export const userProfileStore = declareStore<UserProfileStore>("user_profile");
export const hotkeysStore = declareStore<HotkeysStore>("hotkeys");
export const generalSettingsStore =
	declareStore<GeneralSettingsStore>("general_settings");
export const recordingSettingsStore = declareStore<RecordingSettingsStore>(
	"recording_settings",
	{
		target: null,
		micName: null,
		cameraId: null,
		mode: "instant",
		systemAudio: false,
		organizationId: null,
		cameraDeviceSettings: {},
		microphoneDeviceSettings: {},
	},
);
