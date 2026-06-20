import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import {
	type CaptionSegment,
	type CaptionSettings,
	commands,
} from "~/utils/tauri";

export type CaptionManualPosition = { x: number; y: number };
export type CaptionAnimation = "none" | "bounce" | "pop";
export type CaptionHighlightStyle = "color" | "pill";
export type EditorCaptionSettings = CaptionSettings & {
	manualPosition?: CaptionManualPosition | null;
	preset?: string;
	animation?: CaptionAnimation;
	highlightStyle?: CaptionHighlightStyle;
	uppercase?: boolean;
};

export type CaptionsState = {
	segments: CaptionSegment[];
	settings: EditorCaptionSettings;
	currentCaption: string | null;
};

export type CaptionStylePresetId =
	| "classic"
	| "karaoke"
	| "highlight"
	| "pop"
	| "minimal";

export type CaptionPresetStyle = {
	font: string;
	fontWeight: number;
	size: number;
	color: string;
	backgroundColor: string;
	backgroundOpacity: number;
	outline: boolean;
	outlineColor: string;
	highlightColor: string;
	activeWordHighlight: boolean;
	highlightStyle: CaptionHighlightStyle;
	animation: CaptionAnimation;
	uppercase: boolean;
	fadeDuration: number;
};

export type CaptionStylePreset = {
	id: CaptionStylePresetId;
	label: string;
	description: string;
	style: CaptionPresetStyle;
};

export const CAPTION_STYLE_PRESETS: CaptionStylePreset[] = [
	{
		id: "classic",
		label: "Classic",
		description: "Clean text on a solid rounded background.",
		style: {
			font: "System Sans-Serif",
			fontWeight: 700,
			size: 50,
			color: "#FFFFFF",
			backgroundColor: "#000000",
			backgroundOpacity: 90,
			outline: false,
			outlineColor: "#000000",
			highlightColor: "#FFFFFF",
			activeWordHighlight: false,
			highlightStyle: "color",
			animation: "bounce",
			uppercase: false,
			fadeDuration: 0.2,
		},
	},
	{
		id: "karaoke",
		label: "Karaoke",
		description: "Words light up in sync with speech.",
		style: {
			font: "System Sans-Serif",
			fontWeight: 700,
			size: 52,
			color: "#FFFFFF",
			backgroundColor: "#000000",
			backgroundOpacity: 35,
			outline: false,
			outlineColor: "#000000",
			highlightColor: "#FFD400",
			activeWordHighlight: true,
			highlightStyle: "color",
			animation: "none",
			uppercase: false,
			fadeDuration: 0.12,
		},
	},
	{
		id: "highlight",
		label: "Highlight",
		description: "Bold caps with a pill behind the active word.",
		style: {
			font: "System Sans-Serif",
			fontWeight: 700,
			size: 54,
			color: "#FFFFFF",
			backgroundColor: "#000000",
			backgroundOpacity: 0,
			outline: true,
			outlineColor: "#000000",
			highlightColor: "#7C3AED",
			activeWordHighlight: true,
			highlightStyle: "pill",
			animation: "bounce",
			uppercase: true,
			fadeDuration: 0.12,
		},
	},
	{
		id: "pop",
		label: "Pop",
		description: "Playful caps that pop in with a vibrant accent.",
		style: {
			font: "System Sans-Serif",
			fontWeight: 700,
			size: 56,
			color: "#FFFFFF",
			backgroundColor: "#000000",
			backgroundOpacity: 0,
			outline: true,
			outlineColor: "#000000",
			highlightColor: "#FACC15",
			activeWordHighlight: true,
			highlightStyle: "color",
			animation: "pop",
			uppercase: true,
			fadeDuration: 0.18,
		},
	},
	{
		id: "minimal",
		label: "Minimal",
		description: "Subtle outlined text with no background.",
		style: {
			font: "System Sans-Serif",
			fontWeight: 600,
			size: 46,
			color: "#FFFFFF",
			backgroundColor: "#000000",
			backgroundOpacity: 0,
			outline: true,
			outlineColor: "#000000",
			highlightColor: "#FFFFFF",
			activeWordHighlight: false,
			highlightStyle: "color",
			animation: "none",
			uppercase: false,
			fadeDuration: 0.25,
		},
	},
];

const classicPreset = CAPTION_STYLE_PRESETS[0];

export const defaultCaptionSettings: EditorCaptionSettings = {
	enabled: false,
	position: "bottom-center",
	italic: false,
	exportWithSubtitles: false,
	lingerDuration: 0.4,
	wordTransitionDuration: 0.25,
	manualPosition: null,
	preset: classicPreset.id,
	...classicPreset.style,
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
		updateSettings(settings: Partial<EditorCaptionSettings>) {
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
						italic: state.settings.italic,
						fontWeight: state.settings.fontWeight,
						outline: state.settings.outline,
						outlineColor: state.settings.outlineColor,
						exportWithSubtitles: state.settings.exportWithSubtitles,
						highlightColor: state.settings.highlightColor,
						fadeDuration: state.settings.fadeDuration,
						lingerDuration: state.settings.lingerDuration,
						wordTransitionDuration: state.settings.wordTransitionDuration,
						activeWordHighlight: state.settings.activeWordHighlight,
						manualPosition: state.settings.manualPosition,
						preset: state.settings.preset,
						animation: state.settings.animation,
						highlightStyle: state.settings.highlightStyle,
						uppercase: state.settings.uppercase,
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
