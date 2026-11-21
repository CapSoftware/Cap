import type { EncodedHlsLadder } from "./hls-ladder-encode";
import { withTimeout } from "./media-common";
import { spawn } from "./media-spawn";
import {
	lowerProcessPriority,
	registerSubprocess,
	terminateProcess,
} from "./subprocess";

const AAC_FRAME_SAMPLES = 1024;
const MAX_ERROR_OUTPUT_CHARS = 500;
const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
const TIMESTAMP_ROUNDING_SECONDS = 1e-6;

export interface HlsLadderVerifyOptions {
	sourcePath: string;
	ladder: Pick<EncodedHlsLadder, "files" | "result" | "frameRate">;
	timeoutMs: number;
	niceness?: number;
	signal?: AbortSignal;
}

const TAIL_PACKETS = 64;

// Packets are counted as they stream out of ffprobe, holding only the latest
// few timestamps, so a long video is measured without keeping every packet.
// Packets flagged for discard are not presented: an MP4 cut between keyframes
// keeps the frames before its first shown one, and AAC keeps its priming
// frame, and the ladder encodes neither.
// Some sources (Matroska without block or default durations) give packets no
// duration. Such a last frame would count as zero length and the source would
// measure a frame short of a ladder that has every duration, so it is given
// the usual gap between the stream's final frames.
export class PacketSpan {
	private count = 0;
	private first = Number.POSITIVE_INFINITY;
	private last = Number.NEGATIVE_INFINITY;
	private lastWithoutDuration = Number.NEGATIVE_INFINITY;
	private readonly tail: number[] = [];

	addLine(line: string): void {
		const [pts, duration, flags] = line.trim().split(",");
		const time = Number.parseFloat(pts ?? "");
		if (!Number.isFinite(time) || flags?.includes("D")) return;
		const length = Number.parseFloat(duration ?? "");
		this.add(time, Number.isFinite(length) && length > 0 ? length : null);
	}

	add(pts: number, duration: number | null): void {
		this.count++;
		this.first = Math.min(this.first, pts);
		if (duration === null) {
			this.lastWithoutDuration = Math.max(this.lastWithoutDuration, pts);
		} else {
			this.last = Math.max(this.last, pts + duration);
		}
		if (this.tail.length === TAIL_PACKETS && pts <= (this.tail[0] ?? 0)) return;
		const index = this.tail.findIndex((value) => value > pts);
		this.tail.splice(index === -1 ? this.tail.length : index, 0, pts);
		if (this.tail.length > TAIL_PACKETS) this.tail.shift();
	}

	private tailGap(): number {
		const gaps: number[] = [];
		for (let index = 1; index < this.tail.length; index++) {
			const gap = (this.tail[index] ?? 0) - (this.tail[index - 1] ?? 0);
			if (gap > 0) gaps.push(gap);
		}
		gaps.sort((a, b) => a - b);
		return gaps[Math.floor(gaps.length / 2)] ?? 0;
	}

	seconds(): number | null {
		if (this.count === 0) return null;
		const last =
			this.lastWithoutDuration === Number.NEGATIVE_INFINITY
				? this.last
				: Math.max(this.last, this.lastWithoutDuration + this.tailGap());
		return last - this.first;
	}
}

export function frameSecondsForRate(frameRate: string): number {
	const [numerator, denominator] = frameRate.split("/").map(Number);
	const fps = denominator ? (numerator ?? 0) / denominator : (numerator ?? 0);
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error(`HLS ladder has an unreadable frame rate ${frameRate}`);
	}
	return 1 / fps;
}

// The ladder's AAC keeps the encoder's 1024 samples of priming, which the
// presented source does not have, and pads its last frame to 1024 samples, so
// it runs up to 2047 samples longer than the source (measured 1024 on a PCM
// source and up to 1980 on AAC sources). One AAC frame of tolerance would fail
// every ladder; two cover the priming plus the padding.
export function audioToleranceSeconds(sampleRate: number): number {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new Error("HLS ladder audio has an unreadable sample rate");
	}
	return (2 * AAC_FRAME_SAMPLES) / sampleRate;
}

export function durationMismatch(input: {
	rendition: string;
	track: "video" | "audio";
	measuredSeconds: number | null;
	expectedSeconds: number;
	toleranceSeconds: number;
}): string | null {
	const { rendition, track, measuredSeconds, expectedSeconds } = input;
	if (measuredSeconds === null) {
		return `${rendition} has no ${track} packets, expected ${expectedSeconds.toFixed(3)}s`;
	}
	if (
		Math.abs(measuredSeconds - expectedSeconds) <=
		input.toleranceSeconds + TIMESTAMP_ROUNDING_SECONDS
	)
		return null;
	return `${rendition} ${track} lasts ${measuredSeconds.toFixed(3)}s, expected ${expectedSeconds.toFixed(3)}s within ${input.toleranceSeconds.toFixed(3)}s`;
}

async function readOutput(
	stream: ReadableStream<Uint8Array>,
	onLine?: (line: string) => void,
): Promise<string> {
	const decoder = new TextDecoder();
	let kept = "";
	let buffer = "";
	const take = (text: string) => {
		if (kept.length < MAX_TOOL_OUTPUT_CHARS)
			kept += text.slice(0, MAX_TOOL_OUTPUT_CHARS - kept.length);
		if (!onLine) return;
		buffer += text;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	};
	for await (const chunk of stream)
		take(decoder.decode(chunk, { stream: true }));
	take(decoder.decode());
	if (onLine && buffer.length > 0) onLine(buffer);
	return kept;
}

async function runMediaTool(
	cmd: string[],
	options: Pick<HlsLadderVerifyOptions, "timeoutMs" | "niceness" | "signal">,
	onStdoutLine?: (line: string) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	options.signal?.throwIfAborted();
	const proc = registerSubprocess(
		spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
	);
	lowerProcessPriority(proc, options.niceness);
	const stop = () => {
		void terminateProcess(proc);
	};
	options.signal?.addEventListener("abort", stop, { once: true });
	try {
		const [stdout, stderr, exitCode] = await withTimeout(
			Promise.all([
				readOutput(proc.stdout as ReadableStream<Uint8Array>, onStdoutLine),
				readOutput(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]),
			options.timeoutMs,
			() => terminateProcess(proc),
		);
		options.signal?.throwIfAborted();
		return { exitCode, stdout, stderr };
	} finally {
		options.signal?.removeEventListener("abort", stop);
		await terminateProcess(proc);
	}
}

async function measureStreamSeconds(
	path: string,
	stream: string,
	playlist: boolean,
	options: Pick<HlsLadderVerifyOptions, "timeoutMs" | "niceness" | "signal">,
): Promise<number | null> {
	const span = new PacketSpan();
	const { exitCode, stderr } = await runMediaTool(
		[
			"ffprobe",
			"-v",
			"error",
			...(playlist ? ["-allowed_extensions", "ALL", "-f", "hls"] : []),
			"-select_streams",
			stream,
			"-show_entries",
			"packet=pts_time,duration_time,flags",
			"-of",
			"csv=p=0",
			path,
		],
		options,
		(line) => span.addLine(line),
	);
	if (exitCode !== 0) {
		throw new Error(
			`HLS ladder verification could not read ${stream} packets: ${stderr.slice(0, MAX_ERROR_OUTPUT_CHARS)}`,
		);
	}
	return span.seconds();
}

async function readSampleRate(
	path: string,
	options: Pick<HlsLadderVerifyOptions, "timeoutMs" | "niceness" | "signal">,
): Promise<number> {
	const { exitCode, stdout, stderr } = await runMediaTool(
		[
			"ffprobe",
			"-v",
			"error",
			"-allowed_extensions",
			"ALL",
			"-f",
			"hls",
			"-select_streams",
			"a:0",
			"-show_entries",
			"stream=sample_rate",
			"-of",
			"csv=p=0",
			path,
		],
		options,
	);
	if (exitCode !== 0) {
		throw new Error(
			`HLS ladder verification could not read the audio sample rate: ${stderr.slice(0, MAX_ERROR_OUTPUT_CHARS)}`,
		);
	}
	return Number.parseInt(stdout.trim(), 10);
}

async function decodeFully(
	path: string,
	rendition: string,
	options: Pick<HlsLadderVerifyOptions, "timeoutMs" | "niceness" | "signal">,
): Promise<void> {
	const { exitCode, stderr } = await runMediaTool(
		[
			"ffmpeg",
			"-nostdin",
			"-v",
			"error",
			"-xerror",
			"-allowed_extensions",
			"ALL",
			"-f",
			"hls",
			"-i",
			path,
			"-map",
			"0:v:0",
			"-f",
			"null",
			"-",
		],
		options,
	);
	const errors = stderr.trim();
	if (exitCode !== 0 || errors.length > 0) {
		throw new Error(
			`HLS ladder verification failed: ${rendition} did not decode cleanly (exit ${exitCode}): ${errors.slice(0, MAX_ERROR_OUTPUT_CHARS)}`,
		);
	}
}

function playlistPath(
	ladder: HlsLadderVerifyOptions["ladder"],
	playlist: string,
): string {
	const file = ladder.files.find((candidate) => candidate.name === playlist);
	if (!file) throw new Error(`HLS ladder is missing ${playlist}`);
	return file.path;
}

export async function verifyHlsLadder(
	options: HlsLadderVerifyOptions,
): Promise<void> {
	const { ladder, sourcePath } = options;
	const sourceVideo = await measureStreamSeconds(
		sourcePath,
		"v:0",
		false,
		options,
	);
	if (sourceVideo === null) {
		throw new Error("HLS ladder verification found no video in the source");
	}
	const frameSeconds = frameSecondsForRate(ladder.frameRate);
	const mismatches: string[] = [];

	for (const rendition of ladder.result.renditions) {
		const path = playlistPath(ladder, rendition.playlist);
		await decodeFully(path, rendition.name, options);
		const mismatch = durationMismatch({
			rendition: rendition.name,
			track: "video",
			measuredSeconds: await measureStreamSeconds(path, "v:0", true, options),
			expectedSeconds: sourceVideo,
			toleranceSeconds: frameSeconds,
		});
		if (mismatch) mismatches.push(mismatch);
	}

	const audio = ladder.result.audio;
	if (audio) {
		const path = playlistPath(ladder, audio.playlist);
		const sourceAudio = await measureStreamSeconds(
			sourcePath,
			"a:0",
			false,
			options,
		);
		if (sourceAudio === null) {
			throw new Error("HLS ladder verification found no audio in the source");
		}
		const mismatch = durationMismatch({
			rendition: audio.name,
			track: "audio",
			measuredSeconds: await measureStreamSeconds(path, "a:0", true, options),
			expectedSeconds: sourceAudio,
			toleranceSeconds: audioToleranceSeconds(
				await readSampleRate(path, options),
			),
		});
		if (mismatch) mismatches.push(mismatch);
	}

	if (mismatches.length > 0) {
		throw new Error(`HLS ladder verification failed: ${mismatches.join("; ")}`);
	}
}
