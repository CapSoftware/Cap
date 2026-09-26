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

/** Seconds of output written so far, from an ffmpeg `-progress` line. */
export function encodedSeconds(line: string) {
	const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
	return match ? Number(match[1]) / 1_000_000 : null;
}
