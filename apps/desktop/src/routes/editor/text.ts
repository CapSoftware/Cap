import type { CanvasControls } from "~/utils/socket";
import type { XY } from "~/utils/tauri";

// Font sizes are authored in pixels against a 1080p-tall reference frame;
// the renderer scales them by outputHeight / 1080 (crates/rendering/text.rs).
export const TEXT_REFERENCE_HEIGHT = 1080;
export const TEXT_FONT_SIZE_MIN = 8;
export const TEXT_FONT_SIZE_MAX = 400;

export type TextSegment = {
	start: number;
	end: number;
	track: number;
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

// Picks the starting colour for a new text segment by sampling the composited
// preview frame around the box the text will occupy: black over light
// backdrops (white web pages, light-mode apps), white otherwise. Video and
// mid-tone content reads better with white, so the threshold leans that way.
// Falls back to white when no frame has rendered yet.
export function autoTextColorAt(
	controls: Pick<CanvasControls, "drawLatestFrameToCanvas"> | null | undefined,
	center: XY<number> = { x: 0.5, y: 0.5 },
	size: XY<number> = { x: 0.1, y: 0.055 },
): string {
	const light = "#ffffff";
	if (!controls) return light;
	try {
		const canvas = document.createElement("canvas");
		if (!controls.drawLatestFrameToCanvas(canvas)) return light;
		const ctx = canvas.getContext("2d");
		if (!ctx || canvas.width <= 0 || canvas.height <= 0) return light;

		// Sample generously beyond the initial box — the text grows from its
		// center as the user types.
		const halfW = Math.max(size.x * 1.5, 0.12);
		const halfH = Math.max(size.y * 1.5, 0.07);
		const x0 = Math.max(0, Math.floor((center.x - halfW) * canvas.width));
		const x1 = Math.min(
			canvas.width,
			Math.ceil((center.x + halfW) * canvas.width),
		);
		const y0 = Math.max(0, Math.floor((center.y - halfH) * canvas.height));
		const y1 = Math.min(
			canvas.height,
			Math.ceil((center.y + halfH) * canvas.height),
		);
		const width = x1 - x0;
		const height = y1 - y0;
		if (width <= 0 || height <= 0) return light;

		const pixels = ctx.getImageData(x0, y0, width, height).data;
		const pixelCount = width * height;
		const stride = Math.max(1, Math.floor(pixelCount / 2048));
		let total = 0;
		let count = 0;
		for (let i = 0; i < pixelCount; i += stride) {
			const p = i * 4;
			total +=
				0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
			count++;
		}
		if (count === 0) return light;

		const luma = total / count / 255;
		return luma > 0.6 ? "#000000" : light;
	} catch {
		return light;
	}
}

export const defaultTextSegment = (
	start: number,
	end: number,
): TextSegment => ({
	start,
	end,
	track: 0,
	enabled: true,
	content: "Text",
	center: { x: 0.5, y: 0.5 },
	// Rough hug of "Text" at 48px/1080p; the canvas overlay measures and
	// fits the box to the exact glyph bounds as soon as it renders.
	size: { x: 0.1, y: 0.055 },
	fontFamily: "sans-serif",
	fontSize: 48,
	fontWeight: 700,
	italic: false,
	color: "#ffffff",
	fadeDuration: 0.15,
});
