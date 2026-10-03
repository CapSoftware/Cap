import { createSignal } from "solid-js";

const SAFE_ZONE_STORAGE_KEY = "cap.preview.safeZones";

export type SafeZonePlatform = "reels" | "tiktok" | "shorts";

type Insets = { top: number; bottom: number; left: number; right: number };

// Approximate UI overlays on a 1080x1920 portrait video (captions, buttons,
// account row, progress bar). Platforms change these often, so treat them as
// guidance rather than exact pixels.
const PLATFORM_INSETS: Record<SafeZonePlatform, Insets> = {
	reels: { top: 220, bottom: 420, left: 60, right: 120 },
	tiktok: { top: 160, bottom: 480, left: 60, right: 140 },
	shorts: { top: 190, bottom: 380, left: 60, right: 120 },
};

export const SAFE_ZONE_LABELS: Record<SafeZonePlatform, string> = {
	reels: "Instagram Reels",
	tiktok: "TikTok",
	shorts: "YouTube Shorts",
};

const ORDER: Array<SafeZonePlatform | null> = [
	null,
	"reels",
	"tiktok",
	"shorts",
];

const readPlatform = (): SafeZonePlatform | null => {
	try {
		const value = localStorage.getItem(SAFE_ZONE_STORAGE_KEY);
		return value === "reels" || value === "tiktok" || value === "shorts"
			? value
			: null;
	} catch {
		return null;
	}
};

const [safeZonePlatform, setSafeZonePlatform] =
	createSignal<SafeZonePlatform | null>(readPlatform());

export { safeZonePlatform };

export function cycleSafeZonePlatform() {
	const next = ORDER[(ORDER.indexOf(safeZonePlatform()) + 1) % ORDER.length];
	setSafeZonePlatform(next);
	try {
		localStorage.setItem(SAFE_ZONE_STORAGE_KEY, next ?? "off");
	} catch {}
}

export const isPortraitOutput = (outputWidth: number, outputHeight: number) =>
	outputWidth / Math.max(outputHeight, 1) <= 0.7;

export function safeZoneRect(
	platform: SafeZonePlatform,
	outputWidth: number,
	outputHeight: number,
) {
	if (!isPortraitOutput(outputWidth, outputHeight)) return null;
	const insets = PLATFORM_INSETS[platform];
	return {
		x: insets.left / 1080,
		y: insets.top / 1920,
		w: 1 - (insets.left + insets.right) / 1080,
		h: 1 - (insets.top + insets.bottom) / 1920,
	};
}
