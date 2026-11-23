export const EXPORT_AUDIO_BITRATE = 320_000;

export function exportBitrate(
	width: number,
	height: number,
	fps: number,
	bitsPerPixel: number,
) {
	return Math.round(width * height * exportFrameRate(fps) * bitsPerPixel);
}

function exportFrameRate(fps: number) {
	return Math.max(fps - 30, 0) * 0.6 + 30;
}

export type ExportBitrateSample = {
	bitrate: number;
	target: number;
	pixelRate: number;
};

export type ExportSizeInput = {
	width: number;
	height: number;
	fps: number;
	bitsPerPixel: number;
	durationSeconds: number;
	previous: ExportBitrateSample | null;
};

// Hardware encoders overshoot the target bitrate by at most about 10% but
// often need far less on screen recordings, so an earlier export of the same
// video, scaled to the new pixel rate, narrows the range.
export function exportSizeRangeMb(input: ExportSizeInput): [number, number] {
	const target = exportBitrate(
		input.width,
		input.height,
		input.fps,
		input.bitsPerPixel,
	);
	const ceiling = target * 1.1;
	const megabytes = (videoBitrate: number) =>
		((videoBitrate + EXPORT_AUDIO_BITRATE) * input.durationSeconds) /
		(8 * 1024 * 1024);
	const previous = input.previous;
	if (!previous || previous.pixelRate <= 0)
		return [megabytes(target * 0.2), megabytes(ceiling)];
	const pixelRate = input.width * input.height * exportFrameRate(input.fps);
	const scaled = previous.bitrate * (pixelRate / previous.pixelRate) ** 0.75;
	const expected = Math.min(scaled, target);
	const capped = previous.bitrate > previous.target * 0.85;
	return [
		megabytes(expected * 0.75),
		megabytes(capped ? ceiling : Math.min(expected * 1.25, ceiling)),
	];
}

export function exportBitrateSample(
	bytes: number,
	durationSeconds: number,
	width: number,
	height: number,
	fps: number,
	bitsPerPixel: number,
): ExportBitrateSample | null {
	if (durationSeconds <= 0 || bytes <= 0) return null;
	return {
		bitrate: Math.max((bytes * 8) / durationSeconds - EXPORT_AUDIO_BITRATE, 1),
		target: exportBitrate(width, height, fps, bitsPerPixel),
		pixelRate: width * height * exportFrameRate(fps),
	};
}
