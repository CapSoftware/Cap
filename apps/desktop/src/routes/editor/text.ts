import type { XY } from "~/utils/tauri";

export type TextSegment = {
	start: number;
	end: number;
	enabled: boolean;
	content: string;
	center: XY<number>;
	size: XY<number>;
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	italic: boolean;
	color: string;
	fadeDuration: number;
};

export const defaultTextSegment = (
	start: number,
	end: number,
): TextSegment => ({
	start,
	end,
	enabled: true,
	content: "Text",
	center: { x: 0.5, y: 0.5 },
	size: { x: 0.01, y: 0.01 },
	fontFamily: "sans-serif",
	fontSize: 48,
	fontWeight: 700,
	italic: false,
	color: "#ffffff",
	fadeDuration: 0.15,
});
