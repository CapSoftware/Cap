import type { RenderSpec } from "@cap/editor-render-spec";
import type { ImageCache } from "./image-cache";

export function drawBackground(
	ctx: CanvasRenderingContext2D,
	spec: RenderSpec,
	imageCache: ImageCache,
	resolveBackgroundPath: (path: string) => string,
): void {
	const { outputWidth, outputHeight, backgroundSpec } = spec;

	if (backgroundSpec.type === "color") {
		const [r, g, b] = backgroundSpec.value;
		ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${backgroundSpec.alpha})`;
		ctx.fillRect(0, 0, outputWidth, outputHeight);
		return;
	}

	if (backgroundSpec.type === "gradient") {
		const { from, to, angle } = backgroundSpec;
		const theta = ((90 - angle) * Math.PI) / 180;
		const diagonal =
			Math.sqrt(outputWidth * outputWidth + outputHeight * outputHeight) / 2;
		const dx = Math.cos(theta) * diagonal;
		const dy = -Math.sin(theta) * diagonal;
		const cx = outputWidth / 2;
		const cy = outputHeight / 2;

		const gradient = ctx.createLinearGradient(
			cx - dx,
			cy - dy,
			cx + dx,
			cy + dy,
		);
		gradient.addColorStop(0, `rgb(${from[0]}, ${from[1]}, ${from[2]})`);
		gradient.addColorStop(1, `rgb(${to[0]}, ${to[1]}, ${to[2]})`);
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, outputWidth, outputHeight);
		return;
	}

	if (
		(backgroundSpec.type === "image" || backgroundSpec.type === "wallpaper") &&
		backgroundSpec.path
	) {
		const resolved = resolveBackgroundPath(backgroundSpec.path);
		const img = imageCache.get(resolved);

		if (img) {
			drawImageCover(ctx, img, 0, 0, outputWidth, outputHeight);
		} else {
			ctx.fillStyle = "rgb(128, 128, 128)";
			ctx.fillRect(0, 0, outputWidth, outputHeight);
			imageCache.preload(resolved);
		}
		return;
	}

	ctx.fillStyle = "rgb(255, 255, 255)";
	ctx.fillRect(0, 0, outputWidth, outputHeight);
}

function drawImageCover(
	ctx: CanvasRenderingContext2D,
	img: HTMLImageElement,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
): void {
	const imgRatio = img.naturalWidth / img.naturalHeight;
	const destRatio = dw / dh;

	let sx: number;
	let sy: number;
	let sw: number;
	let sh: number;

	if (imgRatio > destRatio) {
		sh = img.naturalHeight;
		sw = sh * destRatio;
		sx = (img.naturalWidth - sw) / 2;
		sy = 0;
	} else {
		sw = img.naturalWidth;
		sh = sw / destRatio;
		sx = 0;
		sy = (img.naturalHeight - sh) / 2;
	}

	ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}
