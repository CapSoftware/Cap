import { createEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import {
	type CaptionSegment,
	type CaptionSettings,
	commands,
} from "~/utils/tauri";

export type CaptionsState = {
	segments: CaptionSegment[];
	settings: CaptionSettings;
	currentCaption: string | null;
};

const defaultCaptionSettings: CaptionSettings = {
	enabled: false,
	font: "System Sans-Serif",
	size: 24,
	color: "#FFFFFF",
	backgroundColor: "#000000",
	backgroundOpacity: 90,
	position: "bottom-center",
	bold: true,
	italic: false,
	outline: true,
	outlineColor: "#000000",
	exportWithSubtitles: false,
	highlightColor: "#FFFFFF",
	fadeDuration: 0.15,
};

function createCaptionsStore() {
	const [state, setState] = createStore<CaptionsState>({
		segments: [],
		settings: { ...defaultCaptionSettings },
		currentCaption: null,
	});

	return {
		state,
		setState,

		// Actions
		updateSettings(settings: Partial<CaptionSettings>) {
			setState("settings", (prev) => ({ ...prev, ...settings }));
		},

		updateSegments(segments: CaptionSegment[]) {
			setState("segments", segments);
		},

		setCurrentCaption(caption: string | null) {
			setState("currentCaption", caption);
		},

		// New methods for segment operations
		deleteSegment(id: string) {
			setState("segments", (prev) =>
				prev.filter((segment) => segment.id !== id),
			);
		},

		updateSegment(
			id: string,
			updates: Partial<{ start: number; end: number; text: string }>,
		) {
			setState("segments", (prev) =>
				prev.map((segment) =>
					segment.id === id ? { ...segment, ...updates } : segment,
				),
			);
		},

		addSegment(time: number) {
			const id = `segment-${Date.now()}`;
			setState("segments", (prev) => [
				...prev,
				{
					id,
					start: time,
					end: time + 2,
					text: "New caption",
				},
			]);
		},

		// Load captions for a video
		async loadCaptions(videoPath: string) {
			try {
				const captionsData = await commands.loadCaptions(videoPath);
				if (captionsData) {
					const loadedSettings = captionsData.settings
						? { ...defaultCaptionSettings, ...captionsData.settings }
						: { ...defaultCaptionSettings, enabled: true };
					setState((prev) => ({
						...prev,
						segments: captionsData.segments,
						settings: loadedSettings,
					}));
				}

				// Try loading from localStorage as backup
				try {
					const localCaptionsData = JSON.parse(
						localStorage.getItem(`captions-${videoPath}`) || "{}",
					);
					if (localCaptionsData.segments) {
						setState("segments", localCaptionsData.segments);
					}
					if (localCaptionsData.settings) {
						setState("settings", {
							...defaultCaptionSettings,
							...localCaptionsData.settings,
						});
					}
				} catch (e) {
					console.error("Error loading saved captions from localStorage:", e);
				}
			} catch (e) {
				console.error("Error loading captions:", e);
			}
		},

		// Save captions for a video
		async saveCaptions(videoPath: string) {
			try {
				const captionsData = {
					segments: state.segments,
					settings: {
						enabled: state.settings.enabled,
						font: state.settings.font,
						size: state.settings.size,
						color: state.settings.color,
						backgroundColor: state.settings.backgroundColor,
						backgroundOpacity: state.settings.backgroundOpacity,
						position: state.settings.position,
						bold: state.settings.bold,
						italic: state.settings.italic,
						outline: state.settings.outline,
						outlineColor: state.settings.outlineColor,
						exportWithSubtitles: state.settings.exportWithSubtitles,
						highlightColor: state.settings.highlightColor,
						fadeDuration: state.settings.fadeDuration,
					},
				};

				await commands.saveCaptions(videoPath, captionsData);
				localStorage.setItem(
					`captions-${videoPath}`,
					JSON.stringify(captionsData),
				);
			} catch (e) {
				console.error("Error saving captions:", e);
			}
		},

		// Update current caption based on playback time
		updateCurrentCaption(time: number) {
			// Binary search for the correct segment
			const findSegment = (
				time: number,
				segments: CaptionSegment[],
			): CaptionSegment | undefined => {
				let left = 0;
				let right = segments.length - 1;

				while (left <= right) {
					const mid = Math.floor((left + right) / 2);
					const segment = segments[mid];

					if (time >= segment.start && time < segment.end) {
						return segment;
					}

					if (time < segment.start) {
						right = mid - 1;
					} else {
						left = mid + 1;
					}
				}

				return undefined;
			};

			// Find the current segment using binary search
			const currentSegment = findSegment(time, state.segments);

			// Only update if the caption has changed
			if (currentSegment?.text !== state.currentCaption) {
				setState("currentCaption", currentSegment?.text || null);
			}
		},
	};
}

// Create a singleton instance
const captionsStore = createRoot(() => createCaptionsStore());

export { captionsStore };
