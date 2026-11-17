export const CUSTOM_THUMBNAIL_MAX_DIMENSION = 1920;

/**
 * Server actions accept 1 MB bodies. Images are re-encoded in the browser to
 * a JPEG under this, which leaves room for the multipart envelope.
 */
export const CUSTOM_THUMBNAIL_MAX_BYTES = 900 * 1024;

export const CUSTOM_THUMBNAIL_MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export const CUSTOM_THUMBNAIL_ACCEPT = "image/png,image/jpeg,image/webp";

const ACCEPTED_SOURCE_TYPES = new Set(CUSTOM_THUMBNAIL_ACCEPT.split(","));

export function validateThumbnailSourceFile(file: {
	type: string;
	size: number;
}): string | null {
	if (!ACCEPTED_SOURCE_TYPES.has(file.type.toLowerCase())) {
		return "Choose a PNG, JPEG or WebP image";
	}
	if (file.size === 0) return "That image is empty";
	if (file.size > CUSTOM_THUMBNAIL_MAX_SOURCE_BYTES) {
		return "Choose an image under 20 MB";
	}
	return null;
}

export function isJpegData(data: Uint8Array): boolean {
	return (
		data.length > 4 &&
		data[0] === 0xff &&
		data[1] === 0xd8 &&
		data[2] === 0xff &&
		data[data.length - 2] === 0xff &&
		data[data.length - 1] === 0xd9
	);
}

export function fitThumbnailSize(width: number, height: number) {
	if (!(width > 0) || !(height > 0)) return null;
	const scale = Math.min(
		1,
		CUSTOM_THUMBNAIL_MAX_DIMENSION / Math.max(width, height),
	);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Seconds into the video to take a frame from, kept just inside its end so
 * ffmpeg always has a frame to decode. Null for anything that is not a time.
 */
export function clampThumbnailFrameTime(
	time: unknown,
	duration: number | null | undefined,
): number | null {
	if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
		return null;
	}
	const rounded = Math.round(time * 1000) / 1000;
	if (
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration > 0
	) {
		return Math.min(rounded, Math.max(duration - 0.05, 0));
	}
	return rounded;
}

export const CUSTOM_THUMBNAIL_FRAME_FILTER = `scale='min(iw,${CUSTOM_THUMBNAIL_MAX_DIMENSION})':'min(ih,${CUSTOM_THUMBNAIL_MAX_DIMENSION})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
