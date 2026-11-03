import { stat } from "node:fs/promises";
import { spawn } from "bun";
import type { VideoMetadata } from "../lib/job-manager";
import type { FfmpegHlsCapabilities } from "../lib/media-video";
import {
	registerSubprocess,
	terminateProcess,
	unregisterSubprocess,
} from "../lib/subprocess";

const STDERR_LIMIT_BYTES = 64 * 1024;

export const PLAYLIST_INPUT_ARGS = (capabilities: FfmpegHlsCapabilities) => [
	"-protocol_whitelist",
	"file,crypto,data",
	"-allowed_extensions",
	"ALL",
	...(capabilities.allowedSegmentExtensions
		? ["-allowed_segment_extensions", "ALL"]
		: []),
	...(capabilities.extensionPicky ? ["-extension_picky", "0"] : []),
];

export async function runCommand(
	cmd: string[],
	timeoutMs: number,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const proc = registerSubprocess(
		spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
	);
	const stop = () => {
		void terminateProcess(proc);
	};
	signal.addEventListener("abort", stop, { once: true });
	const timer = setTimeout(stop, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		signal.throwIfAborted();
		if (exitCode !== 0) {
			throw new Error(
				`${cmd[0]} exited with code ${exitCode}: ${stderr.slice(-STDERR_LIMIT_BYTES).trim().slice(-600)}`,
			);
		}
		return stdout;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		unregisterSubprocess(proc);
	}
}

interface ProbeStream {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	nb_read_packets?: string;
	duration?: string;
	channels?: number;
	sample_rate?: string;
}

interface ProbeOutput {
	streams?: ProbeStream[];
	format?: { duration?: string; bit_rate?: string };
}

export interface SourceCodecs {
	video: string | null;
	audio: string | null;
	duration: number | null;
}

export async function probeCodecs(
	inputArgs: string[],
	input: string,
	signal: AbortSignal,
): Promise<SourceCodecs> {
	const output = JSON.parse(
		await runCommand(
			[
				"ffprobe",
				"-v",
				"error",
				...inputArgs,
				"-show_entries",
				"stream=codec_type,codec_name:format=duration",
				"-of",
				"json",
				input,
			],
			120_000,
			signal,
		),
	) as ProbeOutput;
	const streams = output.streams ?? [];
	const duration = Number(output.format?.duration);
	return {
		video:
			streams.find((stream) => stream.codec_type === "video")?.codec_name ??
			null,
		audio:
			streams.find((stream) => stream.codec_type === "audio")?.codec_name ??
			null,
		duration: Number.isFinite(duration) && duration > 0 ? duration : null,
	};
}

function parseRate(value: string | undefined): number {
	if (!value) return 0;
	const [numerator, denominator] = value.split("/").map(Number);
	if (!numerator || !denominator) return 0;
	return numerator / denominator;
}

export function resolveFps(
	stream: ProbeStream,
	duration: number,
): number | null {
	const round = (value: number) => Math.round(value * 100) / 100;
	const packets = Number(stream.nb_read_packets);
	if (packets > 0 && duration > 0) {
		const measured = packets / duration;
		if (measured > 0 && measured <= 240) return round(measured);
	}
	for (const rate of [stream.avg_frame_rate, stream.r_frame_rate]) {
		const value = parseRate(rate);
		if (value > 0 && value <= 240) return round(value);
	}
	return null;
}

export async function probeOutput(
	path: string,
	signal: AbortSignal,
): Promise<VideoMetadata> {
	const output = JSON.parse(
		await runCommand(
			[
				"ffprobe",
				"-v",
				"error",
				"-count_packets",
				"-show_entries",
				"format=duration,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_read_packets,duration,channels,sample_rate",
				"-of",
				"json",
				path,
			],
			10 * 60_000,
			signal,
		),
	) as ProbeOutput;
	const streams = output.streams ?? [];
	const video = streams.find((stream) => stream.codec_type === "video");
	const audio = streams.find((stream) => stream.codec_type === "audio");
	const duration = Number(output.format?.duration);
	if (!video?.codec_name || !video.width || !video.height)
		throw new Error("Imported Loom video has no readable video stream");
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error("Imported Loom video has no readable duration");
	const fps = resolveFps(video, Number(video.duration) || duration);
	if (!fps) throw new Error("Imported Loom video has no readable frame rate");
	const fileSize = (await stat(path)).size;
	return {
		duration,
		width: video.width,
		height: video.height,
		fps,
		videoCodec: video.codec_name,
		audioCodec: audio?.codec_name ?? null,
		audioChannels: audio?.channels ?? null,
		sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
		bitrate:
			Number(output.format?.bit_rate) || Math.round((fileSize * 8) / duration),
		fileSize,
	};
}

export type ImportContainer = "mp4" | "webm";

export function chooseContainer(
	codecs: Pick<SourceCodecs, "video" | "audio">,
): ImportContainer | null {
	if (
		codecs.video === "h264" &&
		(codecs.audio === null || codecs.audio === "aac")
	)
		return "mp4";
	if (
		(codecs.video === "vp9" ||
			codecs.video === "vp8" ||
			codecs.video === "av1") &&
		(codecs.audio === null ||
			codecs.audio === "opus" ||
			codecs.audio === "vorbis")
	)
		return "webm";
	return null;
}

export function buildRemuxArgs(
	inputArgs: string[],
	input: string,
	output: string,
	container: ImportContainer,
	hasAudio: boolean,
): string[] {
	return [
		"ffmpeg",
		"-hide_banner",
		"-nostdin",
		"-loglevel",
		"error",
		...inputArgs,
		"-i",
		input,
		"-map",
		"0:v:0",
		...(hasAudio ? ["-map", "0:a:0"] : []),
		"-dn",
		"-sn",
		"-c",
		"copy",
		...(container === "mp4"
			? ["-movflags", "+faststart", "-f", "mp4"]
			: ["-f", "webm"]),
		"-y",
		output,
	];
}

export function buildAudioOnlyArgs(
	inputArgs: string[],
	input: string,
	output: string,
	audioCodec: string,
	duration: number | null,
): string[] {
	return [
		"ffmpeg",
		"-hide_banner",
		"-nostdin",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=1280x720:r=30${duration ? `:d=${duration.toFixed(3)}` : ""}`,
		...inputArgs,
		"-i",
		input,
		"-map",
		"0:v:0",
		"-map",
		"1:a:0",
		"-shortest",
		"-dn",
		"-sn",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-tune",
		"stillimage",
		"-pix_fmt",
		"yuv420p",
		"-threads",
		"2",
		...(audioCodec === "aac"
			? ["-c:a", "copy"]
			: ["-c:a", "aac", "-b:a", "128k"]),
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
		"-y",
		output,
	];
}
