import { BROWSER_RENDERER_FONT_FAMILIES } from "../../engine/browser-renderer-fonts";

export function listSystemFonts(): Promise<string[]> {
	return Promise.resolve([...BROWSER_RENDERER_FONT_FAMILIES]);
}

export const GENERIC_FONT_OPTIONS = [
	{ value: "sans-serif", label: "System Sans" },
	{ value: "serif", label: "System Serif" },
	{ value: "monospace", label: "System Mono" },
];

const GENERIC_VALUES = new Set(GENERIC_FONT_OPTIONS.map((o) => o.value));

export function isGenericFontFamily(value: string) {
	return GENERIC_VALUES.has(value.trim().toLowerCase());
}

export function fontFamilyLabel(value: string) {
	const generic = GENERIC_FONT_OPTIONS.find(
		(option) => option.value === value.trim().toLowerCase(),
	);
	return generic ? generic.label : value;
}

export function cssFontFamily(value: string) {
	const trimmed = value.trim();
	if (isGenericFontFamily(trimmed)) return trimmed.toLowerCase();
	return `"${trimmed.replaceAll('"', "")}", sans-serif`;
}
