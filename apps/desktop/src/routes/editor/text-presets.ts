import type {
	TextAlign,
	TextAnimation,
	TextBackgroundStyle,
	TextSegment,
} from "./text";

export type TextPresetStyle = {
	fontStack: string[];
	fontSize: number;
	fontWeight: number;
	italic: boolean;
	uppercase: boolean;
	align: TextAlign;
	letterSpacing: number;
	lineHeight: number;
	shadow: number;
	glow: number;
	strokeWidth: number;
	strokeColor: string;
	backgroundStyle: TextBackgroundStyle;
	backgroundColor: string | null;
	color: string | null;
	gradientColor: string | null;
	animationIn: TextAnimation;
	animationInDuration: number;
	animationOut: TextAnimation;
	animationOutDuration: number;
};

export type TextPreset = {
	id: string;
	group: string;
	name: string;
	sample: string;
	style: TextPresetStyle;
	// Presets that imply placement (e.g. a lower third) reposition the box.
	center?: { x: number; y: number };
};

export const TEXT_PRESET_GROUPS = [
	"All",
	"Titles",
	"下三分之一字幕条",
	"Callouts",
	"Statements",
	"Code",
];

const SANS = ["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"];
const SERIF = ["Georgia", "Times New Roman", "serif"];
const MONO = ["Menlo", "Consolas", "monospace"];

export const TEXT_PRESETS: TextPreset[] = [
	{
		id: "title",
		group: "标题",
		name: "标题",
		sample: "隆重介绍 Cap",
		style: {
			fontStack: SANS,
			fontSize: 96,
			fontWeight: 700,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: -1,
			lineHeight: 1.1,
			shadow: 0.35,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
			animationIn: "slideUp",
			animationInDuration: 0.35,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "headline",
		group: "标题",
		name: "标题",
		sample: "更快交付",
		style: {
			fontStack: SANS,
			fontSize: 112,
			fontWeight: 800,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: -3,
			lineHeight: 1,
			shadow: 0.3,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
			animationIn: "words",
			animationInDuration: 0.6,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "cinematic",
		group: "标题",
		name: "电影感",
		sample: "第一章",
		style: {
			fontStack: SERIF,
			fontSize: 64,
			fontWeight: 400,
			italic: false,
			uppercase: true,
			align: "center",
			letterSpacing: 12,
			lineHeight: 1.2,
			shadow: 0.25,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
			animationIn: "tracking",
			animationInDuration: 0.9,
			animationOut: "tracking",
			animationOutDuration: 0.6,
		},
	},
	{
		id: "gradient",
		group: "标题",
		name: "渐变",
		sample: "精美文字",
		style: {
			fontStack: SANS,
			fontSize: 104,
			fontWeight: 800,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: -2,
			lineHeight: 1.05,
			shadow: 0,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: "#ffffff",
			gradientColor: "#b388ff",
			animationIn: "zoom",
			animationInDuration: 0.45,
			animationOut: "fade",
			animationOutDuration: 0.3,
		},
	},
	{
		id: "lower-third",
		group: "下三分之一字幕条",
		name: "下三分之一字幕条",
		sample: "张三",
		center: { x: 0.22, y: 0.85 },
		style: {
			fontStack: SANS,
			fontSize: 40,
			fontWeight: 600,
			italic: false,
			uppercase: false,
			align: "left",
			letterSpacing: 0,
			lineHeight: 1.25,
			shadow: 0.4,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
			animationIn: "slideRight",
			animationInDuration: 0.35,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "name-tag",
		group: "下三分之一字幕条",
		name: "姓名标签",
		sample: "Richie · Founder",
		center: { x: 0.2, y: 0.86 },
		style: {
			fontStack: SANS,
			fontSize: 32,
			fontWeight: 600,
			italic: false,
			uppercase: false,
			align: "left",
			letterSpacing: 0.5,
			lineHeight: 1.2,
			shadow: 0,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "pill",
			backgroundColor: "#000000",
			color: "#ffffff",
			gradientColor: null,
			animationIn: "slideRight",
			animationInDuration: 0.3,
			animationOut: "fade",
			animationOutDuration: 0.2,
		},
	},
	{
		id: "caption",
		group: "下三分之一字幕条",
		name: "字幕",
		sample: "由 Cap 录制",
		center: { x: 0.5, y: 0.88 },
		style: {
			fontStack: SANS,
			fontSize: 34,
			fontWeight: 500,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: 0,
			lineHeight: 1.3,
			shadow: 0,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: "#000000",
			color: "#ffffff",
			gradientColor: null,
			animationIn: "fade",
			animationInDuration: 0.25,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "kicker",
		group: "标注",
		name: "引题",
		sample: "新功能",
		style: {
			fontStack: SANS,
			fontSize: 26,
			fontWeight: 700,
			italic: false,
			uppercase: true,
			align: "center",
			letterSpacing: 6,
			lineHeight: 1.2,
			shadow: 0.2,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
			animationIn: "fade",
			animationInDuration: 0.2,
			animationOut: "fade",
			animationOutDuration: 0.2,
		},
	},
	{
		id: "label",
		group: "标注",
		name: "标签",
		sample: "小技巧",
		style: {
			fontStack: SANS,
			fontSize: 28,
			fontWeight: 600,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: 0.3,
			lineHeight: 1.2,
			shadow: 0,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "pill",
			backgroundColor: "#007aff",
			color: "#ffffff",
			gradientColor: null,
			animationIn: "pop",
			animationInDuration: 0.3,
			animationOut: "fade",
			animationOutDuration: 0.2,
		},
	},
	{
		id: "highlight",
		group: "标注",
		name: "高亮",
		sample: "the important part",
		style: {
			fontStack: SANS,
			fontSize: 56,
			fontWeight: 700,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: 0,
			lineHeight: 1.25,
			shadow: 0,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "highlight",
			backgroundColor: "#ffe14d",
			color: "#111111",
			gradientColor: null,
			animationIn: "wipe",
			animationInDuration: 0.5,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "sticker",
		group: "标注",
		name: "贴纸",
		sample: "砰！",
		style: {
			fontStack: SANS,
			fontSize: 88,
			fontWeight: 900,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: -1,
			lineHeight: 1.1,
			shadow: 0.3,
			glow: 0,
			strokeWidth: 8,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: "#ffffff",
			gradientColor: null,
			animationIn: "bounce",
			animationInDuration: 0.5,
			animationOut: "pop",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "neon",
		group: "标注",
		name: "霓虹",
		sample: "焕彩",
		style: {
			fontStack: SANS,
			fontSize: 84,
			fontWeight: 700,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: 1,
			lineHeight: 1.1,
			shadow: 0,
			glow: 1,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: "#7df9ff",
			gradientColor: null,
			animationIn: "fade",
			animationInDuration: 0.5,
			animationOut: "fade",
			animationOutDuration: 0.4,
		},
	},
	{
		id: "stat",
		group: "陈述",
		name: "大号数据",
		sample: "128%",
		style: {
			fontStack: SANS,
			fontSize: 160,
			fontWeight: 800,
			italic: false,
			uppercase: false,
			align: "center",
			letterSpacing: -2,
			lineHeight: 1,
			shadow: 0.3,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
			animationIn: "pop",
			animationInDuration: 0.4,
			animationOut: "fade",
			animationOutDuration: 0.25,
		},
	},
	{
		id: "quote",
		group: "陈述",
		name: "引语",
		sample: "「让它变得毫不费力」",
		style: {
			fontStack: SERIF,
			fontSize: 56,
			fontWeight: 500,
			italic: true,
			uppercase: false,
			align: "center",
			letterSpacing: 0,
			lineHeight: 1.35,
			shadow: 0.2,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
			animationIn: "words",
			animationInDuration: 0.8,
			animationOut: "fade",
			animationOutDuration: 0.3,
		},
	},
	{
		id: "code",
		group: "代码",
		name: "代码",
		sample: "$ cap record",
		style: {
			fontStack: MONO,
			fontSize: 36,
			fontWeight: 400,
			italic: false,
			uppercase: false,
			align: "left",
			letterSpacing: 0,
			lineHeight: 1.4,
			shadow: 0,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: "#0f1115",
			color: "#e6edf3",
			gradientColor: null,
			animationIn: "fade",
			animationInDuration: 0.2,
			animationOut: "fade",
			animationOutDuration: 0.2,
		},
	},
	{
		id: "typewriter",
		group: "代码",
		name: "打字机",
		sample: "正在输入…",
		style: {
			fontStack: MONO,
			fontSize: 44,
			fontWeight: 500,
			italic: false,
			uppercase: false,
			align: "left",
			letterSpacing: 0,
			lineHeight: 1.3,
			shadow: 0,
			glow: 0,
			strokeWidth: 0,
			strokeColor: "#000000",
			backgroundStyle: "box",
			backgroundColor: null,
			color: null,
			gradientColor: null,
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

// Everything the preset styles is applied, including clearing the background,
// gradient, stroke and glow a previous preset left behind; content, timing and
// — unless the preset implies placement — position stay the user's.
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
	segment.uppercase = style.uppercase;
	segment.align = style.align;
	segment.letterSpacing = style.letterSpacing;
	segment.lineHeight = style.lineHeight;
	segment.opacity = 1;
	segment.shadow = style.shadow;
	segment.glow = style.glow;
	segment.strokeWidth = style.strokeWidth;
	segment.strokeColor = style.strokeColor;
	segment.backgroundStyle = style.backgroundStyle;
	segment.backgroundColor = style.backgroundColor;
	segment.gradientColor = style.gradientColor;
	if (style.color !== null) segment.color = style.color;
	segment.animationIn = style.animationIn;
	segment.animationOut = style.animationOut;
	segment.animationInDuration = style.animationInDuration;
	segment.animationOutDuration = style.animationOutDuration;
	segment.fadeDuration = Math.max(
		style.animationInDuration,
		style.animationOutDuration,
	);
	const content = segment.content ?? "";
	if (content.trim() === "" || content === "Text")
		segment.content = preset.sample;
	if (preset.center) {
		segment.center = { ...preset.center };
	}
}

const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) < eps;

const sameOptionalColor = (
	a: string | null | undefined,
	b: string | null | undefined,
) => (a ?? null) === (b ?? null);

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
			(segment.uppercase ?? false) === style.uppercase &&
			segment.align === style.align &&
			near(segment.letterSpacing, style.letterSpacing) &&
			near(segment.lineHeight, style.lineHeight) &&
			near(segment.shadow, style.shadow) &&
			near(segment.glow ?? 0, style.glow) &&
			near(segment.strokeWidth ?? 0, style.strokeWidth) &&
			(style.strokeWidth <= 0 ||
				(segment.strokeColor ?? "#000000") === style.strokeColor) &&
			(segment.backgroundStyle ?? "box") === style.backgroundStyle &&
			sameOptionalColor(segment.backgroundColor, style.backgroundColor) &&
			sameOptionalColor(segment.gradientColor, style.gradientColor) &&
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
