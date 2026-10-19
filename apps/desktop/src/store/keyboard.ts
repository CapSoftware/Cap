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
	style: KeycapStyle;
	theme: KeycapTheme;
	keycapMode: boolean;
	showChassis: boolean;
};

export type KeycapStyle =
	| "pbt"
	| "apple"
	| "retro"
	| "minimal"
	| "m0116"
	| "classic_box";
export type KeycapTheme =
	| "white"
	| "black"
	| "ocean"
	| "emerald"
	| "amber"
	| "rose"
	| "purple";

export const KEYCAP_STYLE_OPTIONS: { label: string; value: KeycapStyle }[] = [
	{ label: "PBT Mechanical (3D)", value: "pbt" },
	{ label: "Apple Modern", value: "apple" },
	{ label: "Minimal Pill", value: "minimal" },
	{ label: "Retro Vintage", value: "retro" },
	{ label: "Apple M0116 Vintage", value: "m0116" },
	{ label: "Classic Subtitle Box", value: "classic_box" },
];

export const KEYCAP_THEME_OPTIONS: { label: string; value: KeycapTheme }[] = [
	{ label: "Pure White", value: "white" },
	{ label: "Stealth Dark", value: "black" },
	{ label: "Ocean Blue", value: "ocean" },
	{ label: "Emerald Green", value: "emerald" },
	{ label: "Amber Orange", value: "amber" },
	{ label: "Rose Quartz", value: "rose" },
	{ label: "Deep Purple", value: "purple" },
];

export const KEYCAP_THEME_COLORS: Record<
	KeycapTheme,
	{ text: string; background: string }
> = {
	white: { text: "#1A1A1A", background: "#EFEFEF" },
	black: { text: "#F5F5F7", background: "#1A1A1E" },
	ocean: { text: "#FFFFFF", background: "#2563EB" },
	emerald: { text: "#FFFFFF", background: "#059669" },
	amber: { text: "#FFFFFF", background: "#D97706" },
	rose: { text: "#FFFFFF", background: "#E11D48" },
	purple: { text: "#FFFFFF", background: "#7C3AED" },
};

export const defaultKeyboardSettings: KeyboardSettings = {
	enabled: false,
	font: "System Sans-Serif",
	size: 50,
	color: "#1A1A1A",
	backgroundColor: "#EFEFEF",
	backgroundOpacity: 95,
	position: "bottom-center",
	fontWeight: 400,
	fadeDuration: 0.15,
	lingerDuration: 0.8,
	groupingThresholdMs: 500,
	showModifiers: true,
	showSpecialKeys: true,
	uppercase: false,
	style: "pbt",
	theme: "white",
	keycapMode: true,
	showChassis: true,
};
