import { produce, unwrap } from "solid-js/store";
import { presetsStore } from "~/store";
import type { PresetsStore, ProjectConfiguration } from "~/utils/tauri";

export type CreatePreset = {
	name: string;
	config: Omit<ProjectConfiguration, "timeline">;
	default: boolean;
};

export function createPresets() {
	const query = presetsStore.createQuery();

	async function updatePresets(fn: (prev: PresetsStore) => void) {
		if (query.isLoading) throw new Error("Presets not loaded");

		let p = query.data;
		if (!p) await presetsStore.set((p = { presets: [], default: null }));

		const newValue = produce(fn)(p);

		await presetsStore.set(newValue);
	}

	return {
		query,
		createPreset: async (preset: CreatePreset) => {
			const config = { ...preset.config };
			// @ts-expect-error we reeeally don't want the timeline in the preset
			config.timeline = undefined;
			config.clips = undefined;

			await updatePresets((store) => {
				store.presets.push({ name: preset.name, config });
				store.default = preset.default ? store.presets.length : store.default;
			});
		},
		deletePreset: (index: number) =>
			updatePresets((store) => {
				store.presets.splice(index, 1);
				store.default =
					index > store.presets.length - 1
						? store.presets.length - 1
						: store.default;
			}),
		setDefault: (index: number) =>
			updatePresets((store) => {
				store.default = index;
			}),
		renamePreset: (index: number, name: string) =>
			updatePresets((store) => {
				store.presets[index].name = name;
			}),
	};
}
