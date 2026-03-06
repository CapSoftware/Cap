export const MIN_KEYBOARD_SEGMENT_SECS = 0.3;

export type KeyboardPosition = "above-captions" | "top" | "bottom";

export type KeyboardSettings = {
	enabled: boolean;
	font: string;
	size: number;
	color: string;
	backgroundColor: string;
	backgroundOpacity: number;
	position: KeyboardPosition;
	fontWeight: number;
	fadeDurationSecs: number;
	lingerDurationSecs: number;
	groupingThresholdMs: number;
	showModifiers: boolean;
	showSpecialKeys: boolean;
};

export const defaultKeyboardSettings: KeyboardSettings = {
	enabled: false,
	font: "System Sans-Serif",
	size: 28,
	color: "#FFFFFF",
	backgroundColor: "#000000",
	backgroundOpacity: 85,
	position: "above-captions",
	fontWeight: 500,
	fadeDurationSecs: 0.15,
	lingerDurationSecs: 0.8,
	groupingThresholdMs: 300,
	showModifiers: true,
	showSpecialKeys: true,
};
