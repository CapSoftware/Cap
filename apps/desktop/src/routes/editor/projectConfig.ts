import type { AspectRatio } from "~/utils/tauri";

export type RGBColor = [number, number, number];

export const DEFAULT_GRADIENT_FROM = [71, 133, 255] satisfies RGBColor;
export const DEFAULT_GRADIENT_TO = [255, 71, 102] satisfies RGBColor;

export const ASPECT_RATIOS = {
	wide: { name: "Wide", ratio: [16, 9] },
	vertical: { name: "Vertical", ratio: [9, 16] },
	square: { name: "Square", ratio: [1, 1] },
	classic: { name: "Classic", ratio: [4, 3] },
	tall: { name: "Tall", ratio: [3, 4] },
} satisfies Record<AspectRatio, { name: string; ratio: [number, number] }>;
