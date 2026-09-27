/**
 * ffmpeg arguments that re-encode a recording's video track into an H.264 MP4
 * the planner can index: a keyframe every `keyframeSeconds`, no B-frames
 * (the index orders samples by decode time), source timestamps kept as they
 * are (browser recordings are variable frame rate) and the moov up front.
 */
export function transcodeArgs(
	input: string,
	output: string,
	keyframeSeconds: number,
	encoder: string,
) {
	const nvenc = encoder === "h264_nvenc";
	return [
		"-hide_banner",
		"-nostdin",
		"-y",
		"-loglevel",
		"error",
		"-progress",
		"pipe:1",
		"-nostats",
		...(nvenc ? ["-hwaccel", "cuda"] : []),
		"-i",
		input,
		"-map",
		"0:v:0",
		"-an",
		"-fps_mode",
		"passthrough",
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		encoder,
		...(nvenc
			? // p1: NVENC is the bottleneck here; p4 took 1.8x as long on a 3K
				// recording for ~11% smaller files at the same quality target.
				["-preset", "p1", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
			: ["-preset", "veryfast", "-crf", "18"]),
		"-bf",
		"0",
		"-force_key_frames",
		`expr:gte(t,n_forced*${keyframeSeconds})`,
		...(nvenc ? ["-forced-idr", "1"] : []),
		"-movflags",
		"+faststart",
		output,
	];
}

export function encodedSeconds(line: string) {
	const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
	return match ? Number(match[1]) / 1_000_000 : null;
}

export const MAX_REMUX_KEYFRAME_GAP_SECONDS = 4;

export function probeArgs(input: string) {
	return [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=codec_name,pix_fmt,has_b_frames:packet=pts_time,dts_time,flags",
		"-of",
		"compact=p=0:nk=0",
		input,
	];
}

/**
 * Whether a probed source can be copied into an indexed MP4 without
 * re-encoding: H.264 4:2:0 (what browsers record as MP4) whose keyframes are
 * close enough together for chunks to start near any point.
 */
export function canRemux(probe: string) {
	const codec = probe.match(/codec_name=([^|\n]+)/)?.[1];
	const pixelFormat = probe.match(/pix_fmt=([^|\n]+)/)?.[1];
	const reorderedFrames = probe.match(/has_b_frames=([^|\n]+)/)?.[1];
	if (
		codec !== "h264" ||
		pixelFormat !== "yuv420p" ||
		reorderedFrames !== "0"
	) {
		return false;
	}
	const keyframes: number[] = [];
	let last = 0;
	for (const line of probe.split("\n")) {
		if (!line.startsWith("pts_time=")) continue;
		const packet = Object.fromEntries(
			line.split("|").map((field) => field.split("=")),
		);
		const time = Number(packet.pts_time);
		const decodeTime = Number(packet.dts_time);
		if (!Number.isFinite(time) || time !== decodeTime || time < last) {
			return false;
		}
		last = time;
		if (packet.flags?.includes("K")) keyframes.push(time);
	}
	if (keyframes.length === 0) return false;
	keyframes.sort((a, b) => a - b);
	let previous = 0;
	for (const time of [...keyframes, last]) {
		if (time - previous > MAX_REMUX_KEYFRAME_GAP_SECONDS) return false;
		previous = time;
	}
	return true;
}

export function remuxArgs(input: string, output: string) {
	return [
		"-hide_banner",
		"-nostdin",
		"-y",
		"-loglevel",
		"error",
		"-progress",
		"pipe:1",
		"-nostats",
		"-i",
		input,
		"-map",
		"0:v:0",
		"-an",
		"-c:v",
		"copy",
		"-movflags",
		"+faststart",
		output,
	];
}
