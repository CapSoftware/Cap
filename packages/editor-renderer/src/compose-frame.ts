import type { RenderCameraSpec, RenderSpec } from "@cap/editor-render-spec";
import { clipMask } from "./draw-mask";
import { drawShadow } from "./draw-shadow";

export interface VideoFrameSource {
	source: unknown;
	width: number;
	height: number;
}

function drawImageCover(
	ctx: CanvasRenderingContext2D,
	img: unknown,
	imgWidth: number,
	imgHeight: number,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
): void {
	const imgRatio = imgWidth / imgHeight;
	const destRatio = dw / dh;

	let sx: number;
	let sy: number;
	let sw: number;
	let sh: number;

	if (imgRatio > destRatio) {
		sh = imgHeight;
		sw = sh * destRatio;
		sx = (imgWidth - sw) / 2;
		sy = 0;
	} else {
		sw = imgWidth;
		sh = sw / destRatio;
		sx = 0;
		sy = (imgHeight - sh) / 2;
	}

	(ctx as unknown as { drawImage(...args: unknown[]): void }).drawImage(
		img,
		sx,
		sy,
		sw,
		sh,
		dx,
		dy,
		dw,
		dh,
	);
}

function drawBackgroundDirect(
	ctx: CanvasRenderingContext2D,
	spec: RenderSpec,
	backgroundImage: unknown | null,
	backgroundImageWidth: number,
	backgroundImageHeight: number,
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
		backgroundImage
	) {
		drawImageCover(
			ctx,
			backgroundImage,
			backgroundImageWidth,
			backgroundImageHeight,
			0,
			0,
			outputWidth,
			outputHeight,
		);
		return;
	}

	ctx.fillStyle = "rgb(255, 255, 255)";
	ctx.fillRect(0, 0, outputWidth, outputHeight);
}

export function composeFrame(
	ctx: CanvasRenderingContext2D,
	spec: RenderSpec,
	videoFrame: VideoFrameSource | null,
	backgroundImage: unknown | null,
	backgroundImageWidth = 0,
	backgroundImageHeight = 0,
	cameraFrame: VideoFrameSource | null = null,
): void {
	ctx.clearRect(0, 0, spec.outputWidth, spec.outputHeight);

	drawBackgroundDirect(
		ctx,
		spec,
		backgroundImage,
		backgroundImageWidth,
		backgroundImageHeight,
	);

	drawShadow(ctx, spec.innerRect, spec.maskSpec, spec.shadowSpec);

	ctx.save();
	clipMask(ctx, spec.innerRect, spec.maskSpec);

	if (videoFrame) {
		const { x, y, width, height } = spec.innerRect;
		const crop = spec.videoCrop;
		const videoRatio = crop.width / crop.height;
		const rectRatio = width / height;

		let drawW: number;
		let drawH: number;
		let drawX: number;
		let drawY: number;

		if (videoRatio > rectRatio) {
			drawW = width;
			drawH = width / videoRatio;
			drawX = x;
			drawY = y + (height - drawH) / 2;
		} else {
			drawH = height;
			drawW = height * videoRatio;
			drawX = x + (width - drawW) / 2;
			drawY = y;
		}

		(ctx as unknown as { drawImage(...args: unknown[]): void }).drawImage(
			videoFrame.source,
			crop.x,
			crop.y,
			crop.width,
			crop.height,
			drawX,
			drawY,
			drawW,
			drawH,
		);
	}

	ctx.restore();

	if (cameraFrame && spec.cameraSpec) {
		drawCameraOverlay(ctx, spec.cameraSpec, cameraFrame);
	}
}

function drawCameraOverlay(
	ctx: CanvasRenderingContext2D,
	cameraSpec: RenderCameraSpec,
	cameraFrame: VideoFrameSource,
): void {
	if (
		cameraFrame.width <= 0 ||
		cameraFrame.height <= 0 ||
		cameraSpec.rect.width <= 0 ||
		cameraSpec.rect.height <= 0
	)
		return;

	const { rect, shadow, mirror } = cameraSpec;

	const camMask = {
		shape: "roundedRect" as const,
		roundingType: cameraSpec.roundingType,
		radiusPx: cameraSpec.rounding,
	};

	drawShadow(ctx, rect, camMask, shadow);

	ctx.save();
	clipMask(ctx, rect, camMask);

	if (mirror) {
		ctx.translate(rect.x + rect.width, rect.y);
		ctx.scale(-1, 1);
	}

	const drawX = mirror ? 0 : rect.x;
	const drawY = mirror ? 0 : rect.y;

	drawImageCover(
		ctx,
		cameraFrame.source,
		cameraFrame.width,
		cameraFrame.height,
		drawX,
		drawY,
		rect.width,
		rect.height,
	);

	ctx.restore();
}
