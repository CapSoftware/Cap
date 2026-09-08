import type { TextAlign, TextAnimation, TextSegment } from "./text";

export type TextPresetStyle = {
	fontStack: string[];
	fontSize: number;
	fontWeight: number;
	italic: boolean;
	align: TextAlign;
	letterSpacing: number;
	lineHeight: number;
	shadow: number;
	animationIn: TextAnimation;
	animationInDuration: number;
	animationOut: TextAnimation;
	animationOutDuration: number;
};

export type TextPreset = {
	id: string;
	name: string;
	sample: string;
	style: TextPresetStyle;
	// Presets that imply placement (e.g. a lower third) reposition the box.
	center?: { x: number; y: number };
};

export const TEXT_PRESETS: TextPreset[] = [
	{
		id: "title",
		name: "Title",
		sample: "Big Title",
		style: {
			fontStack: ["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"],
			fontSize: 96,
			fontWeight: 700,
			italic: false,
			align: "center",
			letterSpacing: -1,
			lineHeight: 1.1,
			shadow: 0.35,
			animationIn: "slideUp",
			animationInDuration: 0.35,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "subtitle",
		name: "Subtitle",
		sample: "A calmer supporting line",
		style: {
			fontStack: ["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"],
			fontSize: 44,
			fontWeight: 500,
			italic: false,
			align: "center",
			letterSpacing: 0,
			lineHeight: 1.3,
			shadow: 0.25,
			animationIn: "fade",
			animationInDuration: 0.3,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "lower-third",
		name: "Lower Third",
		sample: "Name / Context",
		center: { x: 0.22, y: 0.85 },
		style: {
			fontStack: ["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"],
			fontSize: 40,
			fontWeight: 600,
			italic: false,
			align: "left",
			letterSpacing: 0,
			lineHeight: 1.25,
			shadow: 0.4,
			animationIn: "slideUp",
			animationInDuration: 0.3,
			animationOut: "slideDown",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "kicker",
		name: "Kicker",
		sample: "NEW FEATURE",
		style: {
			fontStack: ["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"],
			fontSize: 26,
			fontWeight: 700,
			italic: false,
			align: "center",
			letterSpacing: 6,
			lineHeight: 1.2,
			shadow: 0.2,
			animationIn: "fade",
			animationInDuration: 0.2,
			animationOut: "fade",
			animationOutDuration: 0.2,
		},
	},
	{
		id: "stat",
		name: "Big Stat",
		sample: "128%",
		style: {
			fontStack: ["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"],
			fontSize: 160,
			fontWeight: 800,
			italic: false,
			align: "center",
			letterSpacing: -2,
			lineHeight: 1,
			shadow: 0.3,
			animationIn: "pop",
			animationInDuration: 0.4,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "quote",
		name: "Quote",
		sample: "“Make it feel effortless”",
		style: {
			fontStack: ["Georgia", "Times New Roman", "serif"],
			fontSize: 56,
			fontWeight: 500,
			italic: true,
			align: "center",
			letterSpacing: 0,
			lineHeight: 1.35,
			shadow: 0.2,
			animationIn: "fade",
			animationInDuration: 0.4,
			animationOut: "fade",
			animationOutDuration: 0.3,
		},
	},
	{
		id: "code",
		name: "Code",
		sample: "$ cap record",
		style: {
			fontStack: ["Menlo", "Consolas", "monospace"],
			fontSize: 36,
			fontWeight: 400,
			italic: false,
			align: "left",
			letterSpacing: 0,
			lineHeight: 1.4,
			shadow: 0,
			animationIn: "fade",
			animationInDuration: 0.2,
			animationOut: "fade",
			animationOutDuration: 0.2,
		},
	},
	{
		id: "typewriter",
		name: "Typewriter",
		sample: "typing it out…",
		style: {
			fontStack: ["Menlo", "Consolas", "monospace"],
			fontSize: 44,
			fontWeight: 500,
			italic: false,
			align: "left",
			letterSpacing: 0,
			lineHeight: 1.3,
			shadow: 0,
			animationIn: "typewriter",
			animationInDuration: 0.8,
			animationOut: "fade",
			animationOutDuration: 0.2,
		},
	},
];

// First family of the stack that is actually installed; the generic at the
// end of every stack is the fallback (the renderer resolves generics itself).
export function pickFontFamily(stack: string[], installedFonts: string[]) {
	const installed = new Set(installedFonts.map((name) => name.toLowerCase()));
	for (const family of stack) {
		const normalized = family.toLowerCase();
		if (
			normalized === "sans-serif" ||
			normalized === "serif" ||
			normalized === "monospace"
		)
			return normalized;
		if (installed.has(normalized)) return family;
	}
	return stack[stack.length - 1] ?? "sans-serif";
}

// Everything the preset styles is applied; content, timing, color (kept from
// the auto black/white pick) and — unless the preset implies placement —
// position stay the user's.
export function applyTextPreset(
	segment: TextSegment,
	preset: TextPreset,
	installedFonts: string[],
) {
	const style = preset.style;
	// Scale the box with the font change, top edge fixed, like the Size
	// slider — the canvas overlay re-hugs to exact glyph bounds when visible.
	const boxScale = style.fontSize / (segment.fontSize || 48);
	if (segment.size && segment.center) {
		const topEdge = segment.center.y - segment.size.y / 2;
		segment.size.x = Math.min(segment.size.x * boxScale, 1);
		segment.size.y = segment.size.y * boxScale;
		segment.center.y = topEdge + segment.size.y / 2;
	}
	segment.fontFamily = pickFontFamily(style.fontStack, installedFonts);
	segment.fontSize = style.fontSize;
	segment.fontWeight = style.fontWeight;
	segment.italic = style.italic;
	segment.align = style.align;
	segment.letterSpacing = style.letterSpacing;
	segment.lineHeight = style.lineHeight;
	segment.opacity = 1;
	segment.shadow = style.shadow;
	segment.animationIn = style.animationIn;
	segment.animationOut = style.animationOut;
	segment.animationInDuration = style.animationInDuration;
	segment.animationOutDuration = style.animationOutDuration;
	segment.fadeDuration = Math.max(
		style.animationInDuration,
		style.animationOutDuration,
	);
	if (preset.center) {
		segment.center = { ...preset.center };
	}
}

const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) < eps;

export function matchTextPreset(
	segment: TextSegment,
	installedFonts: string[],
): string | null {
	for (const preset of TEXT_PRESETS) {
		const style = preset.style;
		if (
			segment.fontFamily === pickFontFamily(style.fontStack, installedFonts) &&
			segment.fontWeight === style.fontWeight &&
			segment.italic === style.italic &&
			segment.align === style.align &&
			near(segment.letterSpacing, style.letterSpacing) &&
			near(segment.lineHeight, style.lineHeight) &&
			near(segment.shadow, style.shadow) &&
			segment.animationIn === style.animationIn &&
			segment.animationOut === style.animationOut &&
			near(segment.animationInDuration, style.animationInDuration) &&
			near(segment.animationOutDuration, style.animationOutDuration)
		) {
			return preset.id;
		}
	}
	return null;
}
