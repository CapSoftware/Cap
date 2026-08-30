import { invoke } from "@tauri-apps/api/core";

let fontsPromise: Promise<string[]> | null = null;

// Enumerated Rust-side from the same fontdb the renderer shapes with, so
// every family returned here is guaranteed resolvable at render time.
export function listSystemFonts(): Promise<string[]> {
	fontsPromise ??= invoke<string[]>("list_system_fonts").catch(() => {
		fontsPromise = null;
		return [];
	});
	return fontsPromise;
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

// CSS font-family value for previewing a picked family in the webview.
export function cssFontFamily(value: string) {
	const trimmed = value.trim();
	if (isGenericFontFamily(trimmed)) return trimmed.toLowerCase();
	return `"${trimmed.replaceAll('"', "")}", sans-serif`;
}
