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
	uppercase: boolean;
};

export const defaultKeyboardSettings: KeyboardSettings = {
	enabled: false,
	font: "System Sans-Serif",
	size: 50,
	color: "#FFFFFF",
	backgroundColor: "#000000",
	backgroundOpacity: 95,
	position: "bottom-center",
	fontWeight: 400,
	fadeDuration: 0.15,
	lingerDuration: 0.8,
	groupingThresholdMs: 500,
	showModifiers: true,
	showSpecialKeys: true,
	uppercase: false,
};
