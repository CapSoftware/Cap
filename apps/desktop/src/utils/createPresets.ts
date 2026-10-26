import { produce } from "solid-js/store";
import { presetsStore } from "~/store";
import type { PresetsStore, ProjectConfiguration } from "~/utils/tauri";

export type CreatePreset = {
	name: string;
	config: Omit<ProjectConfiguration, "timeline">;
	default: boolean;
};

type PresetCaptions = ProjectConfiguration["captions"];

/**
 * A preset carries caption *styling*, not the transcript: `segments` name the
 * recording they were transcribed from and `sourceTimed` describes how they
 * are stored. Keep both with the recording, take only `settings` from the
 * preset, and leave the recording's own captions alone when the preset has
 * none (the built-in Default preset stores no captions).
 */
export function keptCaptions(
	preset: PresetCaptions | undefined,
	current: PresetCaptions,
): PresetCaptions {
	if (!current) return null;
	if (!preset) return current;
	return {
		...preset,
		segments: current.segments,
		sourceTimed: current.sourceTimed,
	};
}

export function createPresets() {
	const query = presetsStore.createQuery();

	async function updatePresets(fn: (prev: PresetsStore) => void) {
		if (query.isLoading) throw new Error("Presets not loaded");

		let p = query.data;
		if (!p) {
			p = { presets: [], default: null };
			await presetsStore.set(p);
		}

		const newValue = produce(fn)(p);

		await presetsStore.set(newValue);
	}

	return {
		query,
		createPreset: async (preset: CreatePreset) => {
			const config = {
				...preset.config,
				timeline: null,
				overlayOrder: [],
				clips: [],
				// The transcript belongs to this recording, not to the preset:
				// keep the styling and drop the words.
				captions: preset.config.captions
					? { ...preset.config.captions, segments: [], sourceTimed: false }
					: null,
			};

			await updatePresets((store) => {
				store.presets.push({ name: preset.name, config });
				store.default = preset.default
					? store.presets.length - 1
					: store.default;
			});
		},
		deletePreset: (index: number) =>
			updatePresets((store) => {
				store.presets.splice(index, 1);
				if (store.default === null) return;
				if (index === store.default) {
					store.default = store.presets.length > 0 ? 0 : null;
				} else if (index < store.default) {
					store.default = store.default - 1;
				}
			}),
		setDefault: (index: number | null) =>
			updatePresets((store) => {
				store.default = index;
			}),
		renamePreset: (index: number, name: string) =>
			updatePresets((store) => {
				store.presets[index].name = name;
			}),
		saveToPreset: (
			index: number,
			config: Omit<ProjectConfiguration, "timeline">,
		) =>
			updatePresets((store) => {
				store.presets[index].config = {
					...config,
					timeline: null,
					overlayOrder: [],
					clips: [],
				};
			}),
	};
}
