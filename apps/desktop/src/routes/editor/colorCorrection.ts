import type {
	ColorCorrection,
	ColorCorrectionConfiguration,
} from "~/utils/tauri";

export type ColorCorrectionTarget = "screen" | "camera";

export type ColorCorrectionValues = Omit<ColorCorrection, "preset">;

export const COLOR_PRESET_NONE = "none";
export const COLOR_PRESET_CUSTOM = "custom";

export const IDENTITY_COLOR_VALUES: ColorCorrectionValues = {
	intensity: 1,
	exposure: 0,
	contrast: 0,
	saturation: 0,
	temperature: 0,
	tint: 0,
	fade: 0,
	splitTone: 0,
	vignette: 0,
	grain: 0,
};

export const DEFAULT_COLOR_CORRECTION: ColorCorrection = {
	preset: COLOR_PRESET_NONE,
	...IDENTITY_COLOR_VALUES,
};

export function normalizeColorCorrection(
	config: ColorCorrectionConfiguration | undefined | null,
): ColorCorrectionConfiguration {
	return {
		screen: { ...DEFAULT_COLOR_CORRECTION, ...config?.screen },
		camera: { ...DEFAULT_COLOR_CORRECTION, ...config?.camera },
		gradeCursor: config?.gradeCursor ?? true,
	};
}

export type ColorPresetDefinition = {
	id: string;
	label: string;
	description: string;
	values: ColorCorrectionValues;
	/**
	 * CSS approximation of the grade for the preset thumbnail. Vignette and
	 * grain overlays are derived from `values` instead so they always match.
	 */
	preview: {
		filter?: string;
		overlay?: string;
	};
};

/**
 * The shared thumbnail "scene" every preset preview grades: sky, warm light,
 * and deep shadow so contrast, temperature, and saturation shifts all read.
 */
export const COLOR_PREVIEW_SCENE =
	"linear-gradient(160deg, #60a5fa 0%, #e2e8f0 35%, #fb923c 62%, #1e293b 100%)";

/** Tiny SVG turbulence tile used to preview film grain on preset cards. */
export const COLOR_PREVIEW_GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='64' height='64' filter='url(%23n)'/></svg>")`;

export const COLOR_CORRECTION_PRESETS: ColorPresetDefinition[] = [
	{
		id: COLOR_PRESET_NONE,
		label: "None",
		description: "Original colors, no grade applied",
		values: { ...IDENTITY_COLOR_VALUES },
		preview: {},
	},
	{
		id: "cinematic",
		label: "Cinematic",
		description: "Teal shadows and orange highlights with light grain",
		values: {
			...IDENTITY_COLOR_VALUES,
			contrast: 0.12,
			saturation: 0.06,
			temperature: 0.04,
			splitTone: 0.45,
			vignette: 0.18,
			grain: 0.12,
		},
		preview: {
			filter: "contrast(1.12) saturate(1.12)",
			overlay:
				"linear-gradient(135deg, rgba(13, 148, 136, 0.45), rgba(251, 146, 60, 0.4))",
		},
	},
	{
		id: "noir",
		label: "Noir",
		description: "High-contrast black and white with heavy grain",
		values: {
			...IDENTITY_COLOR_VALUES,
			exposure: 0.04,
			contrast: 0.3,
			saturation: -1,
			fade: 0.06,
			vignette: 0.32,
			grain: 0.35,
		},
		preview: {
			filter: "grayscale(1) contrast(1.35) brightness(1.03)",
		},
	},
	{
		id: "vintage",
		label: "Vintage",
		description: "Faded warm film look with soft contrast",
		values: {
			...IDENTITY_COLOR_VALUES,
			contrast: -0.06,
			saturation: -0.18,
			temperature: 0.22,
			tint: 0.08,
			fade: 0.28,
			vignette: 0.14,
			grain: 0.28,
		},
		preview: {
			filter: "sepia(0.5) contrast(0.92) saturate(0.8) brightness(1.05)",
		},
	},
	{
		id: "frost",
		label: "Frost",
		description: "Cool, crisp tones with muted color",
		values: {
			...IDENTITY_COLOR_VALUES,
			contrast: 0.08,
			saturation: -0.08,
			temperature: -0.3,
			tint: -0.04,
			fade: 0.06,
		},
		preview: {
			filter: "saturate(0.88) contrast(1.06) hue-rotate(-10deg)",
			overlay:
				"linear-gradient(180deg, rgba(125, 211, 252, 0.5), rgba(59, 130, 246, 0.3))",
		},
	},
	{
		id: "golden",
		label: "Golden",
		description: "Warm golden-hour glow",
		values: {
			...IDENTITY_COLOR_VALUES,
			exposure: 0.06,
			contrast: 0.06,
			saturation: 0.12,
			temperature: 0.38,
			fade: 0.04,
			vignette: 0.1,
		},
		preview: {
			filter: "sepia(0.3) saturate(1.2) contrast(1.05) brightness(1.06)",
			overlay:
				"linear-gradient(180deg, rgba(253, 186, 116, 0.4), rgba(251, 113, 36, 0.25))",
		},
	},
	{
		id: "midnight",
		label: "Midnight",
		description: "Dark, moody teal with subdued color",
		values: {
			...IDENTITY_COLOR_VALUES,
			exposure: -0.08,
			contrast: 0.16,
			saturation: -0.22,
			temperature: -0.1,
			splitTone: 0.3,
			vignette: 0.28,
			grain: 0.18,
		},
		preview: {
			filter: "brightness(0.85) contrast(1.16) saturate(0.75)",
			overlay:
				"linear-gradient(180deg, rgba(15, 23, 42, 0.5), rgba(19, 78, 74, 0.45))",
		},
	},
	{
		id: "vivid",
		label: "Vivid",
		description: "Punchy saturation and contrast boost",
		values: {
			...IDENTITY_COLOR_VALUES,
			exposure: 0.02,
			contrast: 0.14,
			saturation: 0.32,
		},
		preview: {
			filter: "saturate(1.45) contrast(1.14)",
		},
	},
	{
		id: "dreamy",
		label: "Dreamy",
		description: "Soft, airy pastels with lifted blacks",
		values: {
			...IDENTITY_COLOR_VALUES,
			exposure: 0.08,
			contrast: -0.14,
			saturation: -0.04,
			temperature: 0.06,
			tint: 0.05,
			fade: 0.3,
			grain: 0.1,
		},
		preview: {
			filter: "brightness(1.1) contrast(0.85) saturate(0.95)",
			overlay:
				"linear-gradient(180deg, rgba(251, 207, 232, 0.45), rgba(196, 181, 253, 0.35))",
		},
	},
];
