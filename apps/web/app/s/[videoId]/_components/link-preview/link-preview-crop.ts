import {
	LINK_PREVIEW_IMAGE_HEIGHT,
	LINK_PREVIEW_IMAGE_MAX_BYTES,
	LINK_PREVIEW_IMAGE_WIDTH,
} from "@/lib/share-link-preview";

export type Size = { width: number; height: number };

/**
 * Where the 1200 × 630 window sits on the source image. `zoom` scales past the
 * smallest size that still covers the window; `focusX`/`focusY` place the
 * window across whatever is left over, 0 at one edge and 1 at the other.
 */
export type CropState = { zoom: number; focusX: number; focusY: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;
export const DEFAULT_CROP: CropState = { zoom: 1, focusX: 0.5, focusY: 0.5 };

const OUTPUT: Size = {
	width: LINK_PREVIEW_IMAGE_WIDTH,
	height: LINK_PREVIEW_IMAGE_HEIGHT,
};

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function cropSourceRect(source: Size, crop: CropState, output = OUTPUT) {
	const cover = Math.max(
		output.width / source.width,
		output.height / source.height,
	);
	const scale = cover * clamp(crop.zoom, MIN_ZOOM, MAX_ZOOM);
	const width = Math.min(source.width, output.width / scale);
	const height = Math.min(source.height, output.height / scale);
	return {
		x: (source.width - width) * clamp(crop.focusX, 0, 1),
		y: (source.height - height) * clamp(crop.focusY, 0, 1),
		width,
		height,
	};
}

export function panCrop(
	source: Size,
	crop: CropState,
	frame: Size,
	deltaX: number,
	deltaY: number,
): CropState {
	const rect = cropSourceRect(source, crop);
	const slackX = source.width - rect.width;
	const slackY = source.height - rect.height;
	const sourcePerPixel = rect.width / frame.width;
	return {
		zoom: crop.zoom,
		focusX:
			slackX > 0.5
				? clamp(crop.focusX - (deltaX * sourcePerPixel) / slackX, 0, 1)
				: 0.5,
		focusY:
			slackY > 0.5
				? clamp(crop.focusY - (deltaY * sourcePerPixel) / slackY, 0, 1)
				: 0.5,
	};
}

// A percentage background position lines the same fraction of the image up
// with the frame, which is exactly what the focus values mean.
export function cropBackgroundStyle(source: Size, crop: CropState) {
	const rect = cropSourceRect(source, crop);
	return {
		backgroundSize: `${(source.width / rect.width) * 100}% ${(source.height / rect.height) * 100}%`,
		backgroundPosition: `${clamp(crop.focusX, 0, 1) * 100}% ${clamp(crop.focusY, 0, 1) * 100}%`,
	};
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
	new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/jpeg", quality),
	);

// Re-encoding also drops whatever metadata the original carried.
export async function renderCroppedImage(
	image: CanvasImageSource,
	source: Size,
	crop: CropState,
	output = OUTPUT,
): Promise<Blob> {
	const canvas = document.createElement("canvas");
	canvas.width = output.width;
	canvas.height = output.height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas is unavailable");
	const rect = cropSourceRect(source, crop, output);
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, output.width, output.height);
	context.imageSmoothingQuality = "high";
	context.drawImage(
		image,
		rect.x,
		rect.y,
		rect.width,
		rect.height,
		0,
		0,
		output.width,
		output.height,
	);

	for (const quality of [0.9, 0.82, 0.72, 0.6]) {
		const blob = await toBlob(canvas, quality);
		if (!blob) break;
		if (blob.size <= LINK_PREVIEW_IMAGE_MAX_BYTES) return blob;
	}
	throw new Error("That image is too detailed to fit. Try another one.");
}

// Fails when the browser won't let a cross-origin video be read back.
export async function captureVideoFrame(
	video: HTMLVideoElement,
): Promise<{ url: string; size: Size }> {
	if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
		throw new Error("The video isn't ready yet");
	}
	const canvas = document.createElement("canvas");
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas is unavailable");
	context.drawImage(video, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/png"),
	);
	if (!blob) throw new Error("Couldn't read this frame");
	return {
		url: URL.createObjectURL(blob),
		size: { width: video.videoWidth, height: video.videoHeight },
	};
}
