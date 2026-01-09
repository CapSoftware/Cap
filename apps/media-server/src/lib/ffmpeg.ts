import { spawn } from "bun";

export interface AudioExtractionOptions {
	format?: "mp3";
	codec?: "libmp3lame";
	bitrate?: string;
}

const DEFAULT_OPTIONS: Required<AudioExtractionOptions> = {
	format: "mp3",
	codec: "libmp3lame",
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

	return /Stream #\d+:\d+.*Audio:/.test(stderrText);
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
		"mp3",
		"pipe:1",
	];

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
		throw new Error(`FFmpeg exited with code ${exitCode}: ${stderrText}`);
	}

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
		"mp3",
		"pipe:1",
	];

	const proc = spawn({
		cmd: ffmpegArgs,
		stdout: "pipe",
		stderr: "pipe",
	});

	return proc.stdout as ReadableStream<Uint8Array>;
}
