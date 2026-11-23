import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { commands } from "../../engine/editor-api";
import type { CaptionSegment, CaptionSettings } from "../../engine/types";

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
const captionAnimations: readonly CaptionAnimation[] = [
	"none",
	"bounce",
	"pop",
];
const captionHighlightStyles: readonly CaptionHighlightStyle[] = [
	"color",
	"pill",
];

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

function isCaptionAnimation(value: unknown): value is CaptionAnimation {
	return captionAnimations.includes(value as CaptionAnimation);
}

function isCaptionHighlightStyle(
	value: unknown,
): value is CaptionHighlightStyle {
	return captionHighlightStyles.includes(value as CaptionHighlightStyle);
}

export function normalizeCaptionSettings(
	settings: Partial<CaptionSettings> | null | undefined,
): EditorCaptionSettings {
	const animation = isCaptionAnimation(settings?.animation)
		? settings.animation
		: defaultCaptionSettings.animation;
	const highlightStyle = isCaptionHighlightStyle(settings?.highlightStyle)
		? settings.highlightStyle
		: defaultCaptionSettings.highlightStyle;

	return {
		...defaultCaptionSettings,
		...settings,
		animation,
		highlightStyle,
	};
}

function createCaptionsStore() {
	const [state, setState] = createStore<CaptionsState>({
		segments: [],
		settings: { ...defaultCaptionSettings },
		currentCaption: null,
	});

	return {
		state,
		setState,

		updateSettings(settings: Partial<EditorCaptionSettings>) {
			setState("settings", (prev) => ({ ...prev, ...settings }));
		},

		updateSegments(segments: CaptionSegment[]) {
			setState("segments", segments);
		},

		setCurrentCaption(caption: string | null) {
			setState("currentCaption", caption);
		},

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

		async loadCaptions(videoPath: string) {
			try {
				const captionsData = await commands.loadCaptions(videoPath);
				if (captionsData) {
					const loadedSettings = captionsData.settings
						? normalizeCaptionSettings(captionsData.settings)
						: normalizeCaptionSettings({ enabled: true });
					setState((prev) => ({
						...prev,
						segments: captionsData.segments,
						settings: loadedSettings,
					}));
				}

				try {
					const localCaptionsData = JSON.parse(
						localStorage.getItem(`captions-${videoPath}`) || "{}",
					);
					if (localCaptionsData.segments) {
						setState("segments", localCaptionsData.segments);
					}
					if (localCaptionsData.settings) {
						setState(
							"settings",
							normalizeCaptionSettings(localCaptionsData.settings),
						);
					}
				} catch (e) {
					console.error("Error loading saved captions from localStorage:", e);
				}
			} catch (e) {
				console.error("Error loading captions:", e);
			}
		},

		updateCurrentCaption(time: number) {
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

			const currentSegment = findSegment(time, state.segments);

			if (currentSegment?.text !== state.currentCaption) {
				setState("currentCaption", currentSegment?.text || null);
			}
		},
	};
}

const captionsStore = createRoot(() => createCaptionsStore());

export { captionsStore };
