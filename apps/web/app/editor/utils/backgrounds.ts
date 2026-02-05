import type { BackgroundSource } from "../types/project-config";

export const BACKGROUND_COLORS = [
	"#FF0000",
	"#FF4500",
	"#FF8C00",
	"#FFD700",
	"#FFFF00",
	"#ADFF2F",
	"#32CD32",
	"#008000",
	"#00CED1",
	"#4785FF",
	"#0000FF",
	"#4B0082",
	"#800080",
	"#A9A9A9",
	"#FFFFFF",
	"#000000",
	"#00000000",
] as const;

export const BACKGROUND_GRADIENTS = [
	{ from: [15, 52, 67], to: [52, 232, 158] },
	{ from: [34, 193, 195], to: [253, 187, 45] },
	{ from: [29, 253, 251], to: [195, 29, 253] },
	{ from: [69, 104, 220], to: [176, 106, 179] },
	{ from: [106, 130, 251], to: [252, 92, 125] },
	{ from: [131, 58, 180], to: [253, 29, 29] },
	{ from: [249, 212, 35], to: [255, 78, 80] },
	{ from: [255, 94, 0], to: [255, 42, 104] },
	{ from: [255, 0, 150], to: [0, 204, 255] },
	{ from: [0, 242, 96], to: [5, 117, 230] },
	{ from: [238, 205, 163], to: [239, 98, 159] },
	{ from: [44, 62, 80], to: [52, 152, 219] },
	{ from: [168, 239, 255], to: [238, 205, 163] },
	{ from: [74, 0, 224], to: [143, 0, 255] },
	{ from: [252, 74, 26], to: [247, 183, 51] },
	{ from: [0, 255, 255], to: [255, 20, 147] },
	{ from: [255, 127, 0], to: [255, 255, 0] },
	{ from: [255, 0, 255], to: [0, 255, 0] },
] as const;

export const WALLPAPER_NAMES = [
	"macOS/tahoe-dusk-min",
	"macOS/tahoe-dawn-min",
	"macOS/tahoe-day-min",
	"macOS/tahoe-night-min",
	"macOS/tahoe-dark",
	"macOS/tahoe-light",
	"macOS/sequoia-dark",
	"macOS/sequoia-light",
	"macOS/sonoma-clouds",
	"macOS/sonoma-dark",
	"macOS/sonoma-evening",
	"macOS/sonoma-fromabove",
	"macOS/sonoma-horizon",
	"macOS/sonoma-light",
	"macOS/sonoma-river",
	"macOS/ventura-dark",
	"macOS/ventura-semi-dark",
	"macOS/ventura",
	"blue/1",
	"blue/2",
	"blue/3",
	"blue/4",
	"blue/5",
	"blue/6",
	"purple/1",
	"purple/2",
	"purple/3",
	"purple/4",
	"purple/5",
	"purple/6",
	"dark/1",
	"dark/2",
	"dark/3",
	"dark/4",
	"dark/5",
	"dark/6",
	"orange/1",
	"orange/2",
	"orange/3",
	"orange/4",
	"orange/5",
	"orange/6",
	"orange/7",
	"orange/8",
	"orange/9",
] as const;

export type WallpaperName = (typeof WALLPAPER_NAMES)[number];

export const BACKGROUND_THEMES = {
	macOS: "macOS",
	dark: "Dark",
	blue: "Blue",
	purple: "Purple",
	orange: "Orange",
} as const;

export function rgbHexToTuple(hex: string): [number, number, number] {
	const normalized = hex.replace("#", "");
	const [r, g, b] = [
		Number.parseInt(normalized.slice(0, 2), 16),
		Number.parseInt(normalized.slice(2, 4), 16),
		Number.parseInt(normalized.slice(4, 6), 16),
	];
	return [r, g, b];
}

export function getWallpaperPath(name: WallpaperName): string {
	return `/backgrounds/${name}.jpg`;
}

export function resolveBackgroundAssetPath(path: string): string {
	if (
		path.startsWith("http://") ||
		path.startsWith("https://") ||
		path.startsWith("data:")
	) {
		return path;
	}

	if (path.startsWith("/")) {
		return path;
	}

	if (path.startsWith("backgrounds/")) {
		return `/${path}`;
	}

	const trimmed = path.endsWith(".jpg") ? path : `${path}.jpg`;
	return `/backgrounds/${trimmed}`;
}

export function resolveBackgroundSourcePath(
	source: Extract<BackgroundSource, { type: "wallpaper" | "image" }>,
): string | null {
	if (!source.path) return null;
	return resolveBackgroundAssetPath(source.path);
}
