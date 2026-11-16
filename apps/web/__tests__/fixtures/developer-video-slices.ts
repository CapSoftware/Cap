import type {
	DeveloperVideoPartState,
	DeveloperVideoSlice,
	DeveloperVideoSlicedHls,
	DeveloperVideoSliceResult,
} from "@cap/database/types";

// A slice's playlist as the encoder writes it: one media file read by byte
// range behind one init segment.
export function slicePlaylist(stream: string, segments: number[]): string {
	let offset = 800;
	const lines = [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		`#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments))}`,
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-PLAYLIST-TYPE:VOD",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		`#EXT-X-MAP:URI="${stream}.m4s",BYTERANGE="800@0"`,
	];
	for (const seconds of segments) {
		lines.push(
			`#EXTINF:${seconds.toFixed(6)},`,
			`#EXT-X-BYTERANGE:1000@${offset}`,
			`${stream}.m4s`,
		);
		offset += 1000;
	}
	lines.push("#EXT-X-ENDLIST", "");
	return lines.join("\n");
}

export function sliceMaster(streams: string[]): string {
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		...streams.flatMap((stream) => [
			"#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080",
			`${stream}.m3u8`,
		]),
		"",
	].join("\n");
}

export function sliceResult(
	seconds: number,
	options: { audioBytes?: number; scale?: number } = {},
): DeveloperVideoSliceResult {
	const scale = options.scale ?? 1;
	return {
		seconds,
		audioBytes: options.audioBytes ?? 0,
		renditions: [
			{
				name: "1080p",
				width: 1920,
				height: 1080,
				bandwidth: 4_000_000 * scale,
				averageBandwidth: 3_000_000 * scale,
				bytes: 5_000 * scale,
				codecs: "avc1.640028",
			},
			{
				name: "360p",
				width: 640,
				height: 360,
				bandwidth: 500_000 * scale,
				averageBandwidth: 400_000 * scale,
				bytes: 700 * scale,
				codecs: "avc1.64001e",
			},
		],
	};
}

export function sliceLadder(result: DeveloperVideoSliceResult, audioBytes = 0) {
	return {
		encoder: "libx264",
		renditions: result.renditions,
		audio: audioBytes > 0 ? { bytes: audioBytes } : null,
	};
}

export const runningJob = (
	token: string,
	overrides: Partial<
		Extract<DeveloperVideoPartState, { state: "running" }>
	> = {},
): DeveloperVideoPartState => ({
	state: "running",
	token,
	jobId: `job-${token}`,
	startedAt: 2_000,
	...overrides,
});

export function slice(
	startSeconds: number,
	durationSeconds: number | null,
	overrides: Partial<DeveloperVideoSlice> = {},
): DeveloperVideoSlice {
	return {
		startSeconds,
		durationSeconds,
		job: { state: "pending" },
		attempts: 0,
		lostJobs: 0,
		...overrides,
	};
}

export function finishedSlice(
	startSeconds: number,
	durationSeconds: number | null,
	token: string,
	result: DeveloperVideoSliceResult,
): DeveloperVideoSlice {
	return slice(startSeconds, durationSeconds, {
		job: { state: "complete", output: token },
		attempts: 1,
		result,
	});
}

// A 300 second video: a 20 second first slice and three more.
export function slicedHls(
	overrides: Partial<DeveloperVideoSlicedHls> = {},
): DeveloperVideoSlicedHls {
	return {
		state: "encoding",
		output: "sliced-1",
		exposed: null,
		hasAudio: false,
		slices: [slice(0, 20), slice(20, 96), slice(116, 96), slice(212, null)],
		...overrides,
	};
}
