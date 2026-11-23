import { createQuery } from "@tanstack/solid-query";
import { onCleanup } from "solid-js";
import { createSerializedStore } from "~/utils/serialized-store";
import { loadEditorStore } from "../engine/editor-store";
import type {
	AnimatedGradientLibrary,
	EditorPreviewQuality,
	PresetsStore,
	VoiceIsolation,
} from "../engine/types";

export type GeneralSettingsStore = {
	defaultZoomAmount?: number | null;
	editorPreviewQuality?: EditorPreviewQuality | null;
};

export type RecordingSettingsStore = {
	organizationId?: string | null;
};

const store = () => loadEditorStore("store");

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
			if (value === undefined) await s.delete(name);
			else {
				const current = (await s.get<T>(name)) || {};
				await s.set(name, {
					...current,
					...value,
				});
			}
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

export const audioEnhancementStore = declareStore<{
	enabledByDefault: boolean;
	isolation: VoiceIsolation;
}>("audio_enhancement", { enabledByDefault: true, isolation: "balanced" });

export const presetsStore = declareStore<PresetsStore>("presets");
const animatedGradientDefaults: AnimatedGradientLibrary = {
	presets: [],
	lastUsed: null,
	selected: false,
};
const animatedGradientStore = declareStore<AnimatedGradientLibrary>(
	"animated_gradients",
	animatedGradientDefaults,
);
export const animatedGradientsStore = {
	...animatedGradientStore,
	...createSerializedStore<AnimatedGradientLibrary>(
		animatedGradientStore,
		animatedGradientDefaults,
	),
};
export const generalSettingsStore =
	declareStore<GeneralSettingsStore>("general_settings");
export const recordingSettingsStore =
	declareStore<RecordingSettingsStore>("recording_settings");
