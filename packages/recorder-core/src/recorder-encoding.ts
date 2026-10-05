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

/**
 * What a video track shows: a screen, a camera that is the whole video, or a
 * camera recorded beside a screen and shown as a bubble over it.
 */
export type RecordingContent = "screen" | "camera" | "cameraOverlay";

// Bits per second at 30 fps for captures up to 720p, 1080p, 1600p and above.
// Screens are mostly still, so the browser spends far less than the target
// on them; the target only caps scrolling and motion, where text stays sharp
// at these rates. A camera is never still (sensor noise, people moving), so
// the encoder always spends its whole target. A camera bubble gets about 60%
// of the old rate, which measured within run-to-run noise of it at the size
// the bubble is shown; a camera that fills the video keeps more.
const BITRATES: Record<RecordingContent, readonly number[]> = {
	screen: [2_500_000, 4_000_000, 6_000_000, 10_000_000],
	camera: [2_600_000, 4_500_000, 6_500_000, 10_000_000],
	cameraOverlay: [2_000_000, 3_500_000, 5_000_000, 8_000_000],
};

// VP8 (Safari's camera recordings) needs about 30% more bits than H.264 to
// hold the same quality on camera footage.
const VP8_BITRATE_SCALE = 1.3;

// Chrome's MediaRecorder defaults to ~2.5 Mb/s, which smears text in screen
// recordings; scale with the pixels being captured instead.
export function recordingBitrate(
	width: number | undefined,
	height: number | undefined,
	frameRate: number | undefined,
	content: RecordingContent = "screen",
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
	return (frameRate ?? 30) > 40 ? Math.round(base * 1.5) : base;
}

type RecorderOptions = MediaRecorderOptions & {
	videoKeyFrameIntervalDuration?: number;
};

/**
 * MediaRecorder options for a video track: H.264 at the level its size needs
 * (a level below the capture size makes some encoders fail), a bitrate for
 * the size and content, and a keyframe every two seconds so the recording can be cut
 * into chunks and remuxed rather than re-encoded later. Browsers ignore the
 * keyframe option when unsupported.
 */
export function recorderOptions(
	mimeType: string,
	track: MediaStreamTrack | undefined,
	isSupported: (type: string) => boolean,
	bitrateScale = 1,
	content: RecordingContent = "screen",
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
