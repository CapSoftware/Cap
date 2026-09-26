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

// Chrome's MediaRecorder defaults to ~2.5 Mb/s, which smears text in screen
// recordings; scale with the pixels being captured instead.
export function recordingBitrate(
	width: number | undefined,
	height: number | undefined,
	frameRate: number | undefined,
) {
	const pixels = (width ?? 1920) * (height ?? 1080);
	const base =
		pixels <= 1280 * 720
			? 3_500_000
			: pixels <= 1920 * 1088
				? 6_000_000
				: pixels <= 2560 * 1600
					? 9_000_000
					: 14_000_000;
	return (frameRate ?? 30) > 40 ? Math.round(base * 1.5) : base;
}

type RecorderOptions = MediaRecorderOptions & {
	videoKeyFrameIntervalDuration?: number;
};

/**
 * MediaRecorder options for a video track: H.264 at the level its size needs
 * (a level below the capture size makes some encoders fail), a bitrate for
 * the size, and a keyframe every two seconds so the recording can be cut
 * into chunks and remuxed rather than re-encoded later. Browsers ignore the
 * keyframe option when unsupported.
 */
export function recorderOptions(
	mimeType: string,
	track: MediaStreamTrack | undefined,
	isSupported: (type: string) => boolean,
): RecorderOptions {
	const settings = track?.getSettings?.() ?? {};
	const options: RecorderOptions = {
		mimeType,
		videoBitsPerSecond: recordingBitrate(
			settings.width,
			settings.height,
			settings.frameRate,
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
