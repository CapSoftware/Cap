import type { XY } from "~/utils/tauri";

export const SCREEN_MAX_PADDING = 0.4;

export function calculateImageTransform(
	frameSize: { width: number; height: number },
	imageSize: { width: number; height: number },
	padding: number,
	crop: { position: XY<number>; size: XY<number> } | null,
) {
	const cropWidth = crop?.size.x ?? imageSize.width;
	const cropHeight = crop?.size.y ?? imageSize.height;
	const croppedAspect = cropWidth / cropHeight;
	const outputAspect = frameSize.width / frameSize.height;

	const paddingFactor = (padding / 100.0) * SCREEN_MAX_PADDING;
	const cropBasis = Math.max(cropWidth, cropHeight);
	const maxPadding = Math.max(
		Math.min((frameSize.width - 1) / 2, (frameSize.height - 1) / 2),
		0,
	);
	const paddingPixels = Math.min(cropBasis * paddingFactor, maxPadding);

	const availableWidth = Math.max(frameSize.width - 2 * paddingPixels, 1);
	const availableHeight = Math.max(frameSize.height - 2 * paddingPixels, 1);

	const isHeightConstrained = croppedAspect <= outputAspect;

	let targetWidth: number;
	let targetHeight: number;
	if (isHeightConstrained) {
		targetHeight = availableHeight;
		targetWidth = availableHeight * croppedAspect;
	} else {
		targetWidth = availableWidth;
		targetHeight = availableWidth / croppedAspect;
	}

	const targetOffsetX = (frameSize.width - targetWidth) / 2;
	const targetOffsetY = (frameSize.height - targetHeight) / 2;

	const offsetX = isHeightConstrained ? targetOffsetX : paddingPixels;
	const offsetY = isHeightConstrained ? paddingPixels : targetOffsetY;

	return {
		offset: { x: offsetX, y: offsetY },
		size: { width: targetWidth, height: targetHeight },
	};
}

export function getImageRect(
	frameSize: { width: number; height: number },
	imageSize: { width: number; height: number } | null,
	padding: number,
	crop: { position: XY<number>; size: XY<number> } | null,
) {
	if (!imageSize) {
		return {
			x: 0,
			y: 0,
			width: frameSize.width,
			height: frameSize.height,
		};
	}

	const transform = calculateImageTransform(
		frameSize,
		imageSize,
		padding,
		crop,
	);

	return {
		x: transform.offset.x,
		y: transform.offset.y,
		width: transform.size.width,
		height: transform.size.height,
	};
}
