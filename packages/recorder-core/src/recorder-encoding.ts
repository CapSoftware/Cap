import type { RecordingPipeline } from "./recorder-utils";

const MAX_LEVEL_4_2_WIDTH = 2048;
const MAX_LEVEL_4_2_HEIGHT = 1088;
const MAX_LEVEL_5_1_WIDTH = 4096;
const MAX_LEVEL_5_1_HEIGHT = 2304;

const LEVEL_4_2_CODEC = "avc1.64002A";
const LEVEL_5_1_CODEC = "avc1.640033";
const LEVEL_5_2_CODEC = "avc1.640034";

export function pickMobileSafeAvcCodec(
	width: number | undefined,
	height: number | undefined,
): string {
	const w = typeof width === "number" && width > 0 ? width : 0;
	const h = typeof height === "number" && height > 0 ? height : 0;

	if (w === 0 || h === 0) {
		return LEVEL_4_2_CODEC;
	}

	if (w <= MAX_LEVEL_4_2_WIDTH && h <= MAX_LEVEL_4_2_HEIGHT) {
		return LEVEL_4_2_CODEC;
	}

	if (w <= MAX_LEVEL_5_1_WIDTH && h <= MAX_LEVEL_5_1_HEIGHT) {
		return LEVEL_5_1_CODEC;
	}

	return LEVEL_5_2_CODEC;
}

export type RecordingContent = "screen" | "camera" | "cameraOverlay";

// Bits per second at 30 fps for captures up to 720p, 1080p, 1600p and above.
// Screens are mostly still, so the target only caps motion. A camera always
// spends its whole target; a bubble measured within run-to-run noise of the
// full rate at about 60% of it.
const BITRATES: Record<RecordingContent, readonly number[]> = {
	screen: [2_500_000, 4_000_000, 6_000_000, 10_000_000],
	camera: [2_600_000, 4_500_000, 6_500_000, 10_000_000],
	cameraOverlay: [2_000_000, 3_500_000, 5_000_000, 8_000_000],
};

// VP8 (Safari's camera recordings) needs about 30% more bits than H.264 to
// hold the same quality on camera footage.
const VP8_BITRATE_SCALE = 1.3;

const HIGH_FRAME_RATE_SCALE = 1.5;
// Chromium's MP4 encoder spends about twice its target above 30 fps, so asking
// for 0.75x lands near the intended 1.5x of the 30 fps rate.
const CHROMIUM_MP4_HIGH_FRAME_RATE_SCALE = 0.75;

// Chrome's MediaRecorder defaults to about 2.5 Mb/s, which smears text in
// screen recordings.
export function recordingBitrate(
	width: number | undefined,
	height: number | undefined,
	frameRate: number | undefined,
	content: RecordingContent = "screen",
	highFrameRateScale = HIGH_FRAME_RATE_SCALE,
) {
	const pixels = (width ?? 1920) * (height ?? 1080);
	const [hd, fullHd, qhd, uhd] = BITRATES[content];
	const base =
		pixels <= 1280 * 720
			? hd
			: pixels <= 1920 * 1088
				? fullHd
				: pixels <= 2560 * 1600
					? qhd
					: uhd;
	return (frameRate ?? 30) > 40 ? Math.round(base * highFrameRateScale) : base;
}

type RecorderOptions = MediaRecorderOptions & {
	videoKeyFrameIntervalDuration?: number;
};

export function recorderOptions(
	mimeType: string,
	track: MediaStreamTrack | undefined,
	isSupported: (type: string) => boolean,
	bitrateScale = 1,
	content: RecordingContent = "screen",
	mode?: RecordingPipeline["mode"],
): RecorderOptions {
	const settings = track?.getSettings?.() ?? {};
	const options: RecorderOptions = {
		mimeType,
		videoBitsPerSecond: Math.round(
			recordingBitrate(
				settings.width,
				settings.height,
				settings.frameRate,
				content,
				mode === "streaming-mp4"
					? CHROMIUM_MP4_HIGH_FRAME_RATE_SCALE
					: HIGH_FRAME_RATE_SCALE,
			) *
				bitrateScale *
				(/vp8/i.test(mimeType) ? VP8_BITRATE_SCALE : 1),
		),
		videoKeyFrameIntervalDuration: 2000,
	};
	if (/^video\/mp4/.test(mimeType) && /avc1\.[0-9a-f]{6}/i.test(mimeType)) {
		const sized = mimeType.replace(
			/avc1\.[0-9a-f]{6}/i,
			pickMobileSafeAvcCodec(settings.width, settings.height),
		);
		if (isSupported(sized)) options.mimeType = sized;
	}
	return options;
}
