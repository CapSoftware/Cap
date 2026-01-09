import { spawn } from "bun";

export interface AudioExtractionOptions {
	format?: "m4a";
	codec?: "aac";
	bitrate?: string;
}

const DEFAULT_OPTIONS: Required<AudioExtractionOptions> = {
	format: "m4a",
	codec: "aac",
	bitrate: "128k",
};

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	const proc = spawn({
		cmd: ["ffmpeg", "-i", videoUrl, "-hide_banner"],
		stdout: "pipe",
		stderr: "pipe",
	});

	const stderrText = await new Response(proc.stderr).text();
	await proc.exited;

	const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderrText);
	console.log(`[ffmpeg] Video has audio track: ${hasAudio}`);
	return hasAudio;
}

export async function extractAudio(
	videoUrl: string,
	options: AudioExtractionOptions = {},
): Promise<Uint8Array> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	const ffmpegArgs = [
		"ffmpeg",
		"-i",
		videoUrl,
		"-vn",
		"-acodec",
		opts.codec,
		"-b:a",
		opts.bitrate,
		"-f",
		"ipod",
		"-movflags",
		"+frag_keyframe+empty_moov",
		"pipe:1",
	];

	console.log(`[ffmpeg] Starting audio extraction: ${ffmpegArgs.join(" ")}`);

	const proc = spawn({
		cmd: ffmpegArgs,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderrText, exitCode] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		console.error(`[ffmpeg] Audio extraction failed:\n${stderrText}`);
		throw new Error(`FFmpeg exited with code ${exitCode}`);
	}

	console.log(
		`[ffmpeg] Audio extraction complete, size: ${stdout.byteLength} bytes`,
	);
	return new Uint8Array(stdout);
}

export async function extractAudioStream(
	videoUrl: string,
	options: AudioExtractionOptions = {},
): Promise<ReadableStream<Uint8Array>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	const ffmpegArgs = [
		"ffmpeg",
		"-i",
		videoUrl,
		"-vn",
		"-acodec",
		opts.codec,
		"-b:a",
		opts.bitrate,
		"-f",
		"ipod",
		"-movflags",
		"+frag_keyframe+empty_moov",
		"pipe:1",
	];

	console.log(
		`[ffmpeg] Starting audio extraction (stream): ${ffmpegArgs.join(" ")}`,
	);

	const proc = spawn({
		cmd: ffmpegArgs,
		stdout: "pipe",
		stderr: "pipe",
	});

	proc.exited.then((code) => {
		if (code !== 0) {
			console.error(`[ffmpeg] Stream extraction failed with code ${code}`);
		}
	});

	return proc.stdout as ReadableStream<Uint8Array>;
}
