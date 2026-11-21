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
const TIMESTAMP_ROUNDING_SECONDS = 1e-6;

export interface PacketTiming {
	pts: number;
	duration: number | null;
}

export interface HlsLadderVerifyOptions {
	sourcePath: string;
	ladder: Pick<EncodedHlsLadder, "files" | "result" | "frameRate">;
	timeoutMs: number;
	niceness?: number;
	signal?: AbortSignal;
}

export function parsePacketTimings(csv: string): PacketTiming[] {
	const packets: PacketTiming[] = [];
	for (const line of csv.split("\n")) {
		const [pts, duration] = line.trim().split(",");
		const time = Number.parseFloat(pts ?? "");
		if (!Number.isFinite(time)) continue;
		const length = Number.parseFloat(duration ?? "");
		packets.push({
			pts: time,
			duration: Number.isFinite(length) && length > 0 ? length : null,
		});
	}
	return packets;
}

function medianGap(sortedPts: number[]): number {
	const gaps: number[] = [];
	for (let index = 1; index < sortedPts.length; index++) {
		const gap = (sortedPts[index] ?? 0) - (sortedPts[index - 1] ?? 0);
		if (gap > 0) gaps.push(gap);
	}
	if (gaps.length === 0) return 0;
	gaps.sort((a, b) => a - b);
	return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

// Some sources (Matroska without block or default durations) give packets no
// duration. The last frame would count as zero length and the source would
// measure a frame short of a ladder that has every duration.
export function packetSpanSeconds(packets: PacketTiming[]): number | null {
	if (packets.length === 0) return null;
	const sortedPts = packets.map((packet) => packet.pts).sort((a, b) => a - b);
	const fallback = medianGap(sortedPts);
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const packet of packets) {
		first = Math.min(first, packet.pts);
		last = Math.max(last, packet.pts + (packet.duration ?? fallback));
	}
	return last - first;
}

export function frameSecondsForRate(frameRate: string): number {
	const [numerator, denominator] = frameRate.split("/").map(Number);
	const fps = denominator ? (numerator ?? 0) / denominator : (numerator ?? 0);
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error(`HLS ladder has an unreadable frame rate ${frameRate}`);
	}
	return 1 / fps;
}

// The AAC encoder adds a frame of priming the source may not have (a PCM
// source measures exactly one AAC frame longer after encoding) and pads the
// last frame, which measured up to 616 of 1024 samples on an AAC source. One
// AAC frame of tolerance would leave no room for that padding.
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

async function runMediaTool(
	cmd: string[],
	options: Pick<HlsLadderVerifyOptions, "timeoutMs" | "niceness" | "signal">,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	options.signal?.throwIfAborted();
	const proc = registerSubprocess(
		spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
	);
	lowerProcessPriority(proc.pid, options.niceness);
	const stop = () => {
		void terminateProcess(proc);
	};
	options.signal?.addEventListener("abort", stop, { once: true });
	try {
		const [stdout, stderr, exitCode] = await withTimeout(
			Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
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

async function readPacketTimings(
	path: string,
	stream: string,
	playlist: boolean,
	options: Pick<HlsLadderVerifyOptions, "timeoutMs" | "niceness" | "signal">,
): Promise<PacketTiming[]> {
	const { exitCode, stdout, stderr } = await runMediaTool(
		[
			"ffprobe",
			"-v",
			"error",
			...(playlist ? ["-allowed_extensions", "ALL", "-f", "hls"] : []),
			"-select_streams",
			stream,
			"-show_entries",
			"packet=pts_time,duration_time",
			"-of",
			"csv=p=0",
			path,
		],
		options,
	);
	if (exitCode !== 0) {
		throw new Error(
			`HLS ladder verification could not read ${stream} packets: ${stderr.slice(0, MAX_ERROR_OUTPUT_CHARS)}`,
		);
	}
	return parsePacketTimings(stdout);
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
	const sourceVideo = packetSpanSeconds(
		await readPacketTimings(sourcePath, "v:0", false, options),
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
			measuredSeconds: packetSpanSeconds(
				await readPacketTimings(path, "v:0", true, options),
			),
			expectedSeconds: sourceVideo,
			toleranceSeconds: frameSeconds,
		});
		if (mismatch) mismatches.push(mismatch);
	}

	const audio = ladder.result.audio;
	if (audio) {
		const path = playlistPath(ladder, audio.playlist);
		const sourceAudio = packetSpanSeconds(
			await readPacketTimings(sourcePath, "a:0", false, options),
		);
		if (sourceAudio === null) {
			throw new Error("HLS ladder verification found no audio in the source");
		}
		const mismatch = durationMismatch({
			rendition: audio.name,
			track: "audio",
			measuredSeconds: packetSpanSeconds(
				await readPacketTimings(path, "a:0", true, options),
			),
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
