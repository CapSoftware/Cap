export type KeyboardSettings = {
	enabled: boolean;
	font: string;
	size: number;
	color: string;
	backgroundColor: string;
	backgroundOpacity: number;
	position: string;
	fontWeight: number;
	fadeDuration: number;
	lingerDuration: number;
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
	fadeDuration: 0.15,
	lingerDuration: 0.8,
	groupingThresholdMs: 300,
	showModifiers: true,
	showSpecialKeys: true,
};
