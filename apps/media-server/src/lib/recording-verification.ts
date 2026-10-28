import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeThreadsFromEnv, PROCESS_TIMEOUT_MS } from "./media-common";
import {
	fetchMedia,
	MediaTransferBudgetError,
	materializeMedia,
} from "./media-transfer";
import {
	proveRecordingPackets,
	RecordingPacketMismatchError,
} from "./recording-packet-proof";
import {
	RecordingTimingError,
	type RecordingVideoTiming,
	readRecordingVideoTiming,
} from "./recording-timing";
import { registerSubprocess, unregisterSubprocess } from "./subprocess";

const MAX_LOCAL_VERIFICATION_MS = 2 * 60 * 60_000;
const DECODER_STALL_MS = 5 * 60_000;

const MAX_OUTPUT_LINE_LENGTH = 16_384;
const MAX_ERROR_LENGTH = 2_048;
const MAX_STDERR_LENGTH = 64 * 1_024;

class RecordingVerificationError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "RecordingVerificationError";
	}
}

export function isRetryableRecordingVerificationError(error: unknown): boolean {
	return (
		(error instanceof RecordingVerificationError ||
			error instanceof RecordingTimingError) &&
		error.retryable
	);
}

export interface RecordingVerificationOptions {
	expectedDuration?: number;
	requireAudio: boolean;
	hasAudio?: boolean;
	sourceEvidence?: RecordingSourceEvidence;
	allowObservedDuration?: boolean;
	// Hashing every decoded frame costs as much as the decode; skip it when the
	// caller has no source evidence to compare against.
	hashDecodedContent?: boolean;
	abortSignal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (progress: { frames: number; totalFrames?: number }) => void;
}

export interface DecodedVideoEvidence {
	frameCount: number;
	startTime: number;
	endTime: number;
	duration: number;
}

export interface DecodedAudioEvidence extends DecodedVideoEvidence {
	sampleCount: number;
	sampleRate: number;
	decodedDuration: number;
}

export interface RecordingVerificationResult {
	fullDecode: true;
	video: DecodedVideoEvidence;
	audio: DecodedAudioEvidence | null;
	integrity?: RecordingIntegrity;
	sourcePreserved?: true;
}

interface StreamIntegrity {
	contentSha256: string;
	timelineSha256: string;
	format: string;
}

interface RecordingIntegrity {
	video: StreamIntegrity;
	audio: StreamIntegrity | null;
}

export interface RecordingSourceEvidence extends RecordingVerificationResult {
	integrity: RecordingIntegrity;
}

export interface RemoteRecordingVerificationOptions
	extends RecordingVerificationOptions {
	expectedObjectIdentity?: string;
	expectedSha256?: string;
	expectedFileSize?: number;
	hashContent?: boolean;
}

export interface RemoteRecordingVerificationResult
	extends RecordingVerificationResult {
	objectIdentity: string;
	fileSize: number;
	remoteSha256?: string;
}

export interface RemoteRecordingBytesOptions {
	expectedObjectIdentity: string;
	expectedSha256: string;
	expectedFileSize: number;
	abortSignal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteRecordingBytesResult {
	objectIdentity: string;
	fileSize: number;
	remoteSha256: string;
}

interface DecodedStream {
	kind?: "video" | "audio";
	timeBase?: number;
	timeBaseNumerator?: bigint;
	timeBaseDenominator?: bigint;
	firstVideoPts?: bigint;
	lastVideoPts?: bigint;
	lastVideoEndPts?: bigint;
	terminalVideoFrameCount?: number;
	sampleRate?: number;
	frameCount: number;
	sampleCount: number;
	decodedBytes: number;
	startTime: number;
	endTime: number;
	previousTime: number;
	maximumGap: number;
	timeline: Hash;
	contentSha256?: string;
	format: string[];
	previousAudioOffset: number;
}

function positiveNumber(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function streamEvidence(stream: DecodedStream): DecodedVideoEvidence {
	return {
		frameCount: stream.frameCount,
		startTime: stream.startTime,
		endTime: stream.endTime,
		duration: stream.endTime - stream.startTime,
	};
}

function relativeVideoNanoseconds(
	stream: DecodedStream,
	timestamp: bigint,
): bigint {
	const { firstVideoPts, timeBaseNumerator, timeBaseDenominator } = stream;
	if (
		firstVideoPts === undefined ||
		!timeBaseNumerator ||
		!timeBaseDenominator
	) {
		throw new Error("Decoded recording frame has no stream metadata");
	}
	const scaled =
		(timestamp - firstVideoPts) * timeBaseNumerator * 1_000_000_000n;
	return (scaled + timeBaseDenominator / 2n) / timeBaseDenominator;
}

function videoTailIntegrity(
	stream: DecodedStream,
	timing: RecordingVideoTiming | undefined,
): string {
	const {
		firstVideoPts,
		lastVideoPts,
		lastVideoEndPts,
		timeBaseNumerator,
		timeBaseDenominator,
	} = stream;
	if (
		firstVideoPts === undefined ||
		lastVideoPts === undefined ||
		lastVideoEndPts === undefined ||
		!timeBaseNumerator ||
		!timeBaseDenominator
	) {
		throw new Error("Decoded recording video endpoint is missing");
	}
	if (!timing) {
		return `end:${relativeVideoNanoseconds(stream, lastVideoEndPts)}\n`;
	}
	const timeScale = BigInt(timing.timeScale);
	const differences = [
		(timing.lastTimestampTicks - timing.firstTimestampTicks) *
			timeBaseDenominator !==
		(lastVideoPts - firstVideoPts) * timeBaseNumerator * timeScale
			? `span ${timing.lastTimestampTicks - timing.firstTimestampTicks}/${timing.timeScale} s vs decoded ${(lastVideoPts - firstVideoPts) * timeBaseNumerator}/${timeBaseDenominator} s`
			: null,
		timing.videoPacketCount !== stream.frameCount
			? `packets ${timing.videoPacketCount} vs decoded frames ${stream.frameCount}`
			: null,
		timing.terminalPacketCount !== stream.terminalVideoFrameCount
			? `final tied packets ${timing.terminalPacketCount} vs decoded ${stream.terminalVideoFrameCount}`
			: null,
	].filter((difference) => difference !== null);
	if (differences.length > 0) {
		throw new Error(
			`Recording container timing does not match decoded video (${differences.join("; ")})`,
		);
	}
	if (!/^[a-f0-9]{64}$/.test(timing.packetTimelineSha256)) {
		throw new Error("Recording container packet timing is missing");
	}
	const packets = `packets:${timing.packetTimelineSha256}\n`;
	if (timing.terminalPacketCount > 1) {
		if (!timing.terminalPacketSha256) {
			throw new Error("Recording terminal packets have no content binding");
		}
		return `${packets}tails:${timing.terminalPacketCount},${timing.terminalPacketSha256}\n`;
	}
	let numerator = timing.lastDurationTicks;
	let denominator = timeScale;
	while (denominator !== 0n) {
		[numerator, denominator] = [denominator, numerator % denominator];
	}
	return `${packets}tail:${timing.lastDurationTicks / numerator}/${timeScale / numerator}\n`;
}

function decodeLine(
	line: string,
	streams: Map<number, DecodedStream>,
	allowVideoTies = false,
): void {
	if (!line) return;
	const digest = line.match(/^(\d+),(v|a),SHA256=([a-f0-9]{64})$/);
	if (digest) {
		const stream = streams.get(Number(digest[1]));
		if (
			!stream ||
			stream.contentSha256 ||
			stream.kind !== (digest[2] === "v" ? "video" : "audio")
		) {
			throw new Error("Invalid decoded recording content digest");
		}
		stream.contentSha256 = digest[3];
		return;
	}
	const metadata = line.match(
		/^#(tb|media_type|sample_rate|dimensions|sar|channel_layout_name) (\d+):\s*(.+)$/,
	);
	if (metadata) {
		const index = Number(metadata[2]);
		if (index > 1) throw new Error("Unexpected decoded recording stream");
		const stream = streams.get(index) ?? {
			frameCount: 0,
			sampleCount: 0,
			decodedBytes: 0,
			startTime: Number.POSITIVE_INFINITY,
			endTime: Number.NEGATIVE_INFINITY,
			previousTime: Number.NEGATIVE_INFINITY,
			maximumGap: 0,
			timeline: createHash("sha256"),
			format: [],
			previousAudioOffset: 0,
		};
		streams.set(index, stream);
		if (metadata[1] === "tb") {
			const ratio = metadata[3].split("/").map(Number);
			if (
				ratio.length !== 2 ||
				!ratio.every((value) => Number.isSafeInteger(value) && value > 0)
			) {
				throw new Error("Invalid decoded recording timebase");
			}
			stream.timeBase = ratio[0] / ratio[1];
			stream.timeBaseNumerator = BigInt(ratio[0]);
			stream.timeBaseDenominator = BigInt(ratio[1]);
		} else if (metadata[1] === "media_type") {
			if (metadata[3] !== "video" && metadata[3] !== "audio") {
				throw new Error("Invalid decoded recording stream type");
			}
			stream.kind = metadata[3];
		} else if (metadata[1] === "sample_rate") {
			stream.sampleRate = Number(metadata[3]);
			if (!Number.isSafeInteger(stream.sampleRate) || stream.sampleRate <= 0) {
				throw new Error("Invalid decoded recording sample rate");
			}
		} else {
			stream.format.push(`${metadata[1]}:${metadata[3]}`);
		}
		return;
	}
	if (line.startsWith("#")) return;
	const columns = line.split(",").map((value) => value.trim());
	const [index, dts, pts, ticks, bytes] = columns.slice(0, 5).map(Number);
	if (
		columns.length < 6 ||
		![index, dts, pts, ticks, bytes].every(Number.isSafeInteger) ||
		!/^0x[a-f0-9]{8}$/i.test(columns[5]) ||
		ticks <= 0 ||
		bytes <= 0
	) {
		throw new Error("Invalid decoded recording frame");
	}
	const stream = streams.get(index);
	if (!stream?.kind || !stream.timeBase) {
		throw new Error("Decoded recording frame has no stream metadata");
	}
	const startTime = pts * stream.timeBase;
	const duration = ticks * stream.timeBase;
	const endTime = startTime + duration;
	if (
		!Number.isFinite(endTime) ||
		startTime < stream.previousTime ||
		((stream.kind === "audio" || !allowVideoTies) &&
			startTime === stream.previousTime)
	) {
		throw new Error("Decoded recording timestamps are invalid");
	}
	stream.maximumGap = Math.max(
		stream.maximumGap,
		stream.frameCount === 0 ? 0 : startTime - stream.endTime,
	);
	stream.startTime = Math.min(stream.startTime, startTime);
	stream.endTime = Math.max(stream.endTime, endTime);
	stream.previousTime = startTime;
	stream.frameCount++;
	if (!Number.isSafeInteger(stream.decodedBytes + bytes)) {
		throw new Error("Decoded recording byte count exceeded its limit");
	}
	stream.decodedBytes += bytes;
	if (stream.kind === "video") {
		const timestamp = BigInt(pts);
		if (stream.lastVideoPts !== undefined && timestamp < stream.lastVideoPts) {
			throw new Error("Decoded recording timestamps are invalid");
		}
		stream.firstVideoPts ??= timestamp;
		stream.terminalVideoFrameCount =
			stream.lastVideoPts === timestamp
				? (stream.terminalVideoFrameCount ?? 0) + 1
				: 1;
		stream.lastVideoPts = timestamp;
		stream.lastVideoEndPts = timestamp + BigInt(ticks);
		stream.timeline.update(
			`${relativeVideoNanoseconds(stream, timestamp)},${bytes}\n`,
		);
	}
	if (stream.kind === "audio") {
		if (!stream.sampleRate) {
			throw new Error("Decoded recording audio has no sample rate");
		}
		const samples = duration * stream.sampleRate;
		if (
			Math.abs(samples - Math.round(samples)) > 0.000_001 ||
			!Number.isSafeInteger(stream.sampleCount + Math.round(samples))
		) {
			throw new Error("Invalid decoded recording sample count");
		}
		const offset = Math.round(
			(startTime - stream.startTime) * stream.sampleRate - stream.sampleCount,
		);
		if (offset !== stream.previousAudioOffset) {
			stream.timeline.update(`${stream.sampleCount},${offset}\n`);
			stream.previousAudioOffset = offset;
		}
		stream.sampleCount += Math.round(samples);
	}
}

async function readFrameEvidence(
	stream: AsyncIterable<Uint8Array>,
	streams: Map<number, DecodedStream>,
	allowVideoTies: boolean,
	onProgress?: () => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	for await (const chunk of stream) {
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			if (newline > MAX_OUTPUT_LINE_LENGTH) {
				throw new Error("Recording decoder output exceeded its limit");
			}
			decodeLine(pending.slice(0, newline).trim(), streams, allowVideoTies);
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
		onProgress?.();
		if (pending.length > MAX_OUTPUT_LINE_LENGTH) {
			throw new Error("Recording decoder output exceeded its limit");
		}
	}
	pending += decoder.decode();
	decodeLine(pending.trim(), streams, allowVideoTies);
}

async function readDecoderErrors(
	stream: AsyncIterable<Uint8Array>,
	input: string,
): Promise<{ error: string; digests: string[] }> {
	const decoder = new TextDecoder();
	let output = "";
	let truncated = false;
	for await (const chunk of stream) {
		const text = decoder.decode(chunk, { stream: true });
		truncated ||= output.length + text.length > MAX_STDERR_LENGTH;
		output += text.slice(0, Math.max(0, MAX_STDERR_LENGTH - output.length));
	}
	output += decoder.decode();
	if (truncated) output = output.slice(0, output.lastIndexOf("\n") + 1);
	const digests: string[] = [];
	output = output
		.split("\n")
		.filter((line) => {
			if (!/^\d+,(v|a),SHA256=[a-f0-9]{64}$/.test(line.trim())) return true;
			digests.push(line.trim());
			return false;
		})
		.join("\n");
	return {
		digests,
		error:
			output
				.replaceAll(input, "<recording input>")
				.replace(/https?:\/\/\S+/g, "<redacted URL>")
				.trim()
				.slice(-MAX_ERROR_LENGTH) ||
			(truncated ? "Decoder error output exceeded its limit" : ""),
	};
}

async function hashDecodedStream(stream: Readable): Promise<{
	bytes: number;
	sha256: string;
}> {
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of stream) {
		if (!Buffer.isBuffer(chunk)) {
			throw new Error("Decoded recording pipe returned invalid bytes");
		}
		if (!Number.isSafeInteger(bytes + chunk.byteLength)) {
			throw new Error("Decoded recording byte count exceeded its limit");
		}
		bytes += chunk.byteLength;
		hash.update(chunk);
	}
	return { bytes, sha256: hash.digest("hex") };
}

async function spawnRecordingDecoder(args: string[], contentPipes: number) {
	const child = spawn("ffmpeg", args, {
		stdio: [
			"ignore",
			"pipe",
			"pipe",
			...Array<"pipe">(contentPipes).fill("pipe"),
		],
	});
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? -1));
	});
	if (!child.pid || !child.stdout || !child.stderr) {
		child.kill("SIGKILL");
		await exited;
		throw new Error("Recording decoder pipes are unavailable");
	}
	return {
		pid: child.pid,
		exited,
		stdout: Readable.toWeb(child.stdout),
		stderr: Readable.toWeb(child.stderr),
		stdio: child.stdio,
		get exitCode() {
			return child.exitCode;
		},
		get signalCode() {
			return child.signalCode;
		},
		kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
	};
}

function validateEvidence(
	streams: Map<number, DecodedStream>,
	options: RecordingVerificationOptions,
	inspectingSource: boolean,
	videoTiming: RecordingVideoTiming | undefined,
	includeContentHashes = true,
): RecordingVerificationResult {
	const video = streams.get(0);
	const audio = streams.get(1);
	if (video?.kind !== "video" || video.frameCount === 0) {
		throw new Error("Recording has no decoded video frames");
	}
	const videoEvidence = streamEvidence(video);
	if (
		!options.sourceEvidence &&
		options.expectedDuration !== undefined &&
		Math.abs(videoEvidence.duration - options.expectedDuration) >
			Math.max(0.5, Math.min(5, options.expectedDuration * 0.01))
	) {
		throw new Error(
			"Decoded recording video does not cover its expected duration",
		);
	}
	let audioEvidence: DecodedAudioEvidence | null = null;
	if (audio?.kind === "audio" && audio.frameCount > 0 && audio.sampleRate) {
		audioEvidence = {
			...streamEvidence(audio),
			sampleCount: audio.sampleCount,
			sampleRate: audio.sampleRate,
			decodedDuration: audio.sampleCount / audio.sampleRate,
		};
	}
	if (options.requireAudio && !audioEvidence) {
		throw new Error("Decoded recording is missing required audio coverage");
	}
	if (options.requireAudio && !options.sourceEvidence && !inspectingSource) {
		const tolerance = Math.min(0.5, videoEvidence.duration * 0.1);
		if (
			!audioEvidence ||
			audioEvidence.startTime > videoEvidence.startTime + tolerance ||
			audioEvidence.endTime < videoEvidence.endTime - tolerance ||
			audioEvidence.decodedDuration < videoEvidence.duration - tolerance ||
			(audio?.maximumGap ?? 0) > tolerance
		) {
			throw new Error("Decoded recording is missing required audio coverage");
		}
	}
	const integrity = (stream: DecodedStream): StreamIntegrity => {
		if (!stream.contentSha256) {
			throw new Error("Decoded recording content digest is missing");
		}
		if (stream.kind === "video") {
			// Remuxing can change a fragment's nominal packet duration without changing
			// presentation timestamps. FFmpeg 7 can also omit the true final duration.
			stream.timeline.update(videoTailIntegrity(stream, videoTiming));
		}
		return {
			contentSha256: stream.contentSha256,
			timelineSha256: stream.timeline.digest("hex"),
			format: stream.format.join(";"),
		};
	};
	const result: RecordingVerificationResult = {
		fullDecode: true,
		video: videoEvidence,
		audio: audioEvidence,
		...(includeContentHashes
			? {
					integrity: {
						video: integrity(video),
						audio: audioEvidence && audio ? integrity(audio) : null,
					},
				}
			: {}),
	};
	if (videoTiming?.terminalPacketCount === 1) {
		const duration =
			Number(
				videoTiming.lastTimestampTicks -
					videoTiming.firstTimestampTicks +
					videoTiming.lastDurationTicks,
			) / videoTiming.timeScale;
		result.video = {
			...result.video,
			duration,
			endTime: result.video.startTime + duration,
		};
	}
	if (options.sourceEvidence) {
		if (!result.integrity)
			throw new Error("Recording decoded integrity is missing");
		assertSourcePreserved(options.sourceEvidence, {
			...result,
			integrity: result.integrity,
		});
		result.sourcePreserved = true;
	}
	return result;
}

function assertSourcePreserved(
	source: RecordingSourceEvidence,
	output: RecordingSourceEvidence,
): void {
	const sameIntegrity = (a: StreamIntegrity, b: StreamIntegrity) =>
		a.contentSha256 === b.contentSha256 &&
		a.timelineSha256 === b.timelineSha256 &&
		a.format === b.format;
	const videoMismatches = [
		{
			preserved: source.video.frameCount === output.video.frameCount,
			name: "frame count",
		},
		{
			preserved:
				source.integrity.video.contentSha256 ===
				output.integrity.video.contentSha256,
			name: "decoded content",
		},
		{
			preserved:
				source.integrity.video.timelineSha256 ===
				output.integrity.video.timelineSha256,
			name: "presentation timeline",
		},
		{
			preserved:
				source.integrity.video.format === output.integrity.video.format,
			name: "display format",
		},
	]
		.filter(({ preserved }) => !preserved)
		.map(({ name }) => name);
	if (videoMismatches.length > 0) {
		throw new Error(
			`Recording output does not preserve source video: ${videoMismatches.join(", ")}`,
		);
	}
	if (Boolean(source.audio) !== Boolean(output.audio)) {
		throw new Error("Recording output does not preserve source audio");
	}
	if (source.audio && output.audio) {
		if (
			!source.integrity.audio ||
			!output.integrity.audio ||
			source.audio.sampleRate !== output.audio.sampleRate ||
			source.audio.sampleCount !== output.audio.sampleCount ||
			!sameIntegrity(source.integrity.audio, output.integrity.audio)
		) {
			throw new Error("Recording output does not preserve source audio");
		}
		const sourceOffset = source.audio.startTime - source.video.startTime;
		const outputOffset = output.audio.startTime - output.video.startTime;
		if (Math.abs(sourceOffset - outputOffset) > 0.000_001) {
			throw new Error("Recording output does not preserve source A/V sync");
		}
	}
}

export async function inspectRecordingSources(
	videoInputPath: string,
	audioInputPath: string | null,
	options: Pick<RecordingVerificationOptions, "abortSignal" | "timeoutMs"> = {},
): Promise<RecordingSourceEvidence> {
	if (
		!isAbsolute(videoInputPath) ||
		(audioInputPath !== null && !isAbsolute(audioInputPath))
	) {
		throw new Error("Recording sources must be local regular MP4 files");
	}
	const result = await decodeRecording(
		videoInputPath,
		{ ...options, requireAudio: audioInputPath !== null },
		undefined,
		audioInputPath,
	);
	if (!result.integrity)
		throw new Error("Recording decoded integrity is missing");
	return { ...result, integrity: result.integrity };
}

export interface RecordingVideoChunkSource {
	init: string;
	segments: string[];
}

export function verifyDecodeChunks(
	env: Record<string, string | undefined> = process.env,
): number {
	const value = Number(env.MEDIA_SERVER_VERIFY_DECODE_CHUNKS?.trim());
	return Number.isInteger(value) && value > 1 ? Math.min(value, 16) : 1;
}

class ChunkedDecodeUnavailable extends Error {}

const DECODED_STREAM_METADATA =
	/^#(tb|media_type|sample_rate|dimensions|sar|channel_layout_name) (\d+):/;

const metadataOf = (lines: string[]) =>
	lines.filter((line) => DECODED_STREAM_METADATA.test(line)).join("\n");

function describeHeaderChange(first: string, other: string): string {
	const fields = (header: string) =>
		new Map(
			header
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [name, ...value] = line.slice(1).split(": ");
					return [name, value.join(": ")] as const;
				}),
		);
	const before = fields(first);
	const after = fields(other);
	const changes = [...new Set([...before.keys(), ...after.keys()])]
		.filter((name) => before.get(name) !== after.get(name))
		.map(
			(name) =>
				`${name}: ${before.get(name) ?? "none"} -> ${after.get(name) ?? "none"}`,
		);
	return changes.join("; ").slice(0, 200) || "unknown";
}

async function collectDecoderLines(
	stream: AsyncIterable<Uint8Array>,
	lines: string[],
	onLine: () => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	const take = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		lines.push(trimmed);
		if (!trimmed.startsWith("#")) onLine();
	};
	for await (const chunk of stream) {
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			if (newline > MAX_OUTPUT_LINE_LENGTH) {
				throw new Error("Recording decoder output exceeded its limit");
			}
			take(pending.slice(0, newline));
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
		if (pending.length > MAX_OUTPUT_LINE_LENGTH) {
			throw new Error("Recording decoder output exceeded its limit");
		}
	}
	take(pending + decoder.decode());
}

async function concatFiles(
	paths: string[],
	target: string,
	signal?: AbortSignal,
): Promise<void> {
	const output = await open(target, "w");
	try {
		for (const path of paths) {
			signal?.throwIfAborted();
			for await (const chunk of createReadStream(path, { signal })) {
				for (let offset = 0; offset < chunk.byteLength; ) {
					const { bytesWritten } = await output.write(
						chunk,
						offset,
						chunk.byteLength - offset,
					);
					if (bytesWritten <= 0)
						throw new Error(
							"Recording verification chunk could not be written",
						);
					offset += bytesWritten;
				}
			}
		}
	} finally {
		await output.close();
	}
}

const KEYFRAME_SEARCH_SEGMENTS = 8;

async function countOutputLines(
	command: string,
	args: string[],
	pattern: RegExp,
	signal?: AbortSignal,
): Promise<number | null> {
	const child = spawn(command, args, {
		stdio: ["ignore", "pipe", "ignore"],
		signal,
		timeout: 60_000,
	});
	let count = 0;
	let pending = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		pending += text;
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) if (pattern.test(line)) count++;
	});
	const code = await new Promise<number | null>((resolve) => {
		child.once("error", () => resolve(null));
		child.once("close", resolve);
	});
	if (pattern.test(pending)) count++;
	return code === 0 ? count : null;
}

// A fragment can open with a sync sample the decoder still cannot start from
// cleanly, so prove it: decoding it alone must yield a frame for every packet.
async function decodesCleanlyFromStart(
	init: string,
	segment: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const input = `concat:${init}|${segment}`;
	const [packets, frames] = await Promise.all([
		countOutputLines(
			"ffprobe",
			[
				"-v",
				"error",
				"-protocol_whitelist",
				"file,concat",
				"-select_streams",
				"v:0",
				"-show_entries",
				"packet=flags",
				"-of",
				"csv=p=0",
				input,
			],
			/^\S/,
			signal,
		),
		countOutputLines(
			"ffmpeg",
			[
				"-hide_banner",
				"-nostdin",
				"-copyts",
				"-v",
				"error",
				"-xerror",
				"-err_detect",
				"explode+crccheck",
				"-threads",
				"1",
				"-protocol_whitelist",
				"file,concat",
				"-f",
				"mov",
				"-i",
				input,
				"-map",
				"0:v:0",
				"-fps_mode",
				"passthrough",
				"-enc_time_base:v",
				"-1",
				"-c:v",
				"wrapped_avframe",
				"-bsf:v",
				"setts=pts=N:dts=N:duration=1",
				"-f",
				"framecrc",
				"pipe:1",
			],
			/^0,/,
			signal,
		),
	]);
	return packets !== null && packets > 0 && frames === packets;
}

// Splits only where a fragment decodes cleanly on its own, searching a few
// fragments past each even split point and merging runs when none does.
async function keyframeAlignedGroups(
	source: RecordingVideoChunkSource,
	chunkCount: number,
	signal?: AbortSignal,
): Promise<string[][]> {
	const total = source.segments.length;
	const per = Math.ceil(total / chunkCount);
	const targets = Array.from(
		{ length: chunkCount - 1 },
		(_, index) => (index + 1) * per,
	).filter((target) => target < total);
	const found = await Promise.all(
		targets.map(async (target) => {
			for (
				let index = target;
				index < Math.min(total, target + KEYFRAME_SEARCH_SEGMENTS);
				index++
			) {
				if (
					await decodesCleanlyFromStart(
						source.init,
						source.segments[index],
						signal,
					)
				)
					return index;
			}
			return undefined;
		}),
	);
	const boundaries = [0];
	for (const index of found) {
		if (index !== undefined && index > boundaries[boundaries.length - 1])
			boundaries.push(index);
	}
	return boundaries.map((start, position) =>
		source.segments.slice(start, boundaries[position + 1] ?? total),
	);
}

const CHUNK_DECODE_BASE_ARGS = [
	"-hide_banner",
	"-nostdin",
	"-copyts",
	"-v",
	"error",
	"-xerror",
	"-err_detect",
	"explode+crccheck",
	"-filter_threads",
	"1",
	"-filter_complex_threads",
	"1",
];

function videoChunkDecodeArgs(path: string, threads: string) {
	return [
		...CHUNK_DECODE_BASE_ARGS,
		"-threads",
		threads,
		"-protocol_whitelist",
		"file",
		"-f",
		"mov",
		"-i",
		path,
		"-map",
		"0:v:0",
		"-fps_mode",
		"passthrough",
		"-enc_time_base:v",
		"-1",
		"-c:v",
		"wrapped_avframe",
		"-bsf:v",
		"setts=pts=N:dts=N:duration=1",
		"-max_interleave_delta",
		"1",
		"-f",
		"framecrc",
		"pipe:1",
	];
}

// Frame lines of whole fragments that were decoded during the recording, as one chunk of this decoder
// would print them; the caller has matched each fragment's content identity to this recording's source.
export interface PreverifiedVideoRun {
	segments: number;
	lines: string[];
}

// Decodes one run of fragments exactly as a chunk of the final verification would. Returns null when the
// run cannot stand alone or the decoder complains, so the final verification decodes those fragments itself.
export async function decodePreverifiedRun(
	init: string,
	segments: string[],
	directory: string,
	signal?: AbortSignal,
): Promise<string[] | null> {
	const first = segments[0];
	if (!first || !(await decodesCleanlyFromStart(init, first, signal)))
		return null;
	const chunkPath = join(directory, "preverify-run.mp4");
	await concatFiles([init, ...segments], chunkPath, signal);
	const decoder = registerSubprocess(
		await spawnRecordingDecoder(videoChunkDecodeArgs(chunkPath, "2"), 0),
	);
	const kill = () => {
		if (decoder.exitCode === null) decoder.kill("SIGKILL");
	};
	signal?.addEventListener("abort", kill, { once: true });
	const lines: string[] = [];
	try {
		const [exit, , stderr] = await Promise.all([
			decoder.exited,
			collectDecoderLines(decoder.stdout, lines, () => {}),
			readDecoderErrors(decoder.stderr, chunkPath),
		]);
		signal?.throwIfAborted();
		if (exit !== 0 || stderr.error || decoder.signalCode) return null;
		return lines.some((line) => !line.startsWith("#")) ? lines : null;
	} finally {
		signal?.removeEventListener("abort", kill);
		kill();
		unregisterSubprocess(decoder);
		await rm(chunkPath, { force: true });
	}
}

// Decodes the packet-proven video as independent runs of whole fragments in
// parallel, then replays their frame lines through the same parser and evidence
// checks as one decode. Any decoder complaint falls back to the single decode,
// which stays the judge of whether a recording is corrupt.
async function decodePacketProvenChunks(
	outputPath: string,
	source: RecordingVideoChunkSource,
	chunkCount: number,
	options: RecordingVerificationOptions,
	packetProof: Awaited<ReturnType<typeof proveRecordingPackets>>,
	preverified: PreverifiedVideoRun[] = [],
): Promise<RecordingVerificationResult> {
	const cached = [...preverified];
	let covered = cached.reduce((total, run) => total + run.segments, 0);
	if (covered > source.segments.length)
		throw new ChunkedDecodeUnavailable("preverified runs exceed the source");
	// The fragments after the cached runs are decoded from their first one, so it has to decode on its own.
	while (
		cached.length > 0 &&
		covered < source.segments.length &&
		!(await decodesCleanlyFromStart(
			source.init,
			source.segments[covered],
			options.abortSignal,
		))
	)
		covered -= cached.pop()?.segments ?? 0;
	const remaining = source.segments.slice(covered);
	const groups =
		remaining.length === 0
			? []
			: await keyframeAlignedGroups(
					{ init: source.init, segments: remaining },
					chunkCount,
					options.abortSignal,
				);
	if (cached.length === 0 && groups.length < 2)
		throw new ChunkedDecodeUnavailable("no cleanly decodable fragment runs");
	const directory = dirname(outputPath);
	const chunkPaths = groups.map((_, index) =>
		join(directory, `verify-chunk-${index}.mp4`),
	);
	const configuredThreads = Number(
		decodeThreadsFromEnv("MEDIA_SERVER_VERIFY_DECODE_THREADS", 0),
	);
	const threads = String(
		Math.max(
			1,
			Math.floor(
				(configuredThreads > 0 ? configuredThreads : availableParallelism()) /
					Math.max(1, groups.length),
			),
		),
	);
	const base = CHUNK_DECODE_BASE_ARGS;
	const decoders: Awaited<ReturnType<typeof spawnRecordingDecoder>>[] = [];
	const outputs: string[][] = [];
	const readers: Promise<unknown>[] = [];
	let failure: Error | undefined;
	let decodedFrames = 0;
	let lastAdvance = performance.now();
	let lastReport = 0;
	const stopAll = () => {
		for (const decoder of decoders) {
			if (decoder.exitCode === null) {
				try {
					decoder.kill("SIGKILL");
				} catch {
					failure ??= new Error("Recording decoder termination failed");
				}
			}
		}
	};
	const cancel = () => {
		failure ??= new Error("Recording verification was cancelled");
		stopAll();
	};
	options.abortSignal?.addEventListener("abort", cancel, { once: true });
	const timeout = setTimeout(() => {
		failure ??= new RecordingVerificationError(
			"Recording verification timed out",
			true,
		);
		stopAll();
	}, options.timeoutMs ?? MAX_LOCAL_VERIFICATION_MS);
	const stall = setInterval(() => {
		if (performance.now() - lastAdvance > DECODER_STALL_MS) {
			failure ??= new RecordingVerificationError(
				"Recording decoder stopped making progress",
				true,
			);
			stopAll();
		}
	}, 1000);
	const onFrame = () => {
		decodedFrames++;
		lastAdvance = performance.now();
		if (performance.now() - lastReport >= 1000) {
			lastReport = performance.now();
			options.onProgress?.({
				frames: decodedFrames,
				totalFrames: packetProof.videoPackets,
			});
		}
	};
	try {
		await Promise.all(
			groups.map((group, index) =>
				concatFiles(
					[source.init, ...group],
					chunkPaths[index],
					options.abortSignal,
				),
			),
		);
		const jobs = [
			...chunkPaths.map((path) => videoChunkDecodeArgs(path, threads)),
			...(packetProof.hasAudio
				? [
						[
							...base,
							"-threads",
							"1",
							"-protocol_whitelist",
							"file",
							"-f",
							"mov",
							"-i",
							outputPath,
							"-map",
							"0:a:0",
							"-c:a",
							"pcm_f64le",
							"-threads",
							"1",
							"-max_interleave_delta",
							"1",
							"-f",
							"framecrc",
							"pipe:1",
						],
					]
				: []),
		];
		const errors: Promise<{ error: string }>[] = [];
		// A chunk's header describes its first decoded frame, so a mismatch is known
		// as soon as each chunk emits one frame; stop then instead of decoding everything first.
		const headers = new Map<number, string>();
		const checkHeader = (index: number, lines: string[]) => {
			if (headers.has(index)) return;
			headers.set(index, metadataOf(lines));
			const first = headers.get(0);
			if (first === undefined) return;
			for (const [other, header] of headers) {
				if (other === 0 || header === first) continue;
				failure ??= new ChunkedDecodeUnavailable(
					`chunk stream parameters differ (${describeHeaderChange(first, header)})`,
				);
				stopAll();
				return;
			}
		};
		for (const [index, args] of jobs.entries()) {
			options.abortSignal?.throwIfAborted();
			const decoder = registerSubprocess(await spawnRecordingDecoder(args, 0));
			decoders.push(decoder);
			const lines: string[] = [];
			outputs.push(lines);
			const frames = collectDecoderLines(
				decoder.stdout,
				lines,
				index < chunkPaths.length
					? () => {
							checkHeader(index, lines);
							onFrame();
						}
					: onFrame,
			);
			const stderr = readDecoderErrors(decoder.stderr, outputPath);
			frames.catch(stopAll);
			stderr.catch(stopAll);
			readers.push(frames, stderr);
			errors.push(stderr);
		}
		const exits = await Promise.all(decoders.map((decoder) => decoder.exited));
		await Promise.all(readers);
		if (failure) throw failure;
		const stderr = await Promise.all(errors);
		for (const [index, decoder] of decoders.entries()) {
			if (exits[index] !== 0 || stderr[index].error || decoder.signalCode)
				throw new ChunkedDecodeUnavailable(
					stderr[index].error || `decoder exited with ${exits[index]}`,
				);
		}
		const streams = new Map<number, DecodedStream>();
		const videoOutputs = [
			...cached.map((run) => run.lines),
			...outputs.slice(0, chunkPaths.length),
		];
		const videoMetadata = metadataOf(videoOutputs[0] ?? []);
		let offset = 0;
		for (const [index, lines] of videoOutputs.entries()) {
			const metadata = metadataOf(lines);
			if (index > 0 && metadata !== videoMetadata)
				throw new ChunkedDecodeUnavailable(
					`chunk stream parameters differ (${describeHeaderChange(videoMetadata, metadata)})`,
				);
			let frames = 0;
			for (const line of lines) {
				if (line.startsWith("#")) {
					if (index === 0) decodeLine(line, streams, true);
					continue;
				}
				const columns = line.split(",").map((value) => value.trim());
				if (columns[0] !== "0")
					throw new ChunkedDecodeUnavailable("unexpected chunk stream");
				const dts = Number(columns[1]);
				const pts = Number(columns[2]);
				if (dts !== frames || pts !== frames)
					throw new ChunkedDecodeUnavailable("chunk frames are not contiguous");
				columns[1] = String(dts + offset);
				columns[2] = String(pts + offset);
				decodeLine(columns.join(", "), streams, true);
				frames++;
			}
			offset += frames;
		}
		// A decoder silently skips frames until a keyframe, so a short count is a split problem, not proof.
		if (offset !== packetProof.videoPackets)
			throw new ChunkedDecodeUnavailable("chunk frame count differs");
		if (packetProof.hasAudio) {
			for (const line of outputs[chunkPaths.length]) {
				if (line.startsWith("#")) {
					const metadata = line.match(DECODED_STREAM_METADATA);
					if (metadata?.[2] === "0")
						decodeLine(line.replace(/^(#\w+) 0:/, "$1 1:"), streams, true);
					continue;
				}
				if (!line.startsWith("0,"))
					throw new ChunkedDecodeUnavailable("unexpected audio stream");
				decodeLine(`1${line.slice(1)}`, streams, true);
			}
		}
		return validateEvidence(
			streams,
			options,
			true,
			packetProof.outputTiming,
			false,
		);
	} finally {
		clearTimeout(timeout);
		clearInterval(stall);
		options.abortSignal?.removeEventListener("abort", cancel);
		stopAll();
		await Promise.allSettled([
			...decoders.map((decoder) => decoder.exited),
			...readers,
		]);
		for (const decoder of decoders) unregisterSubprocess(decoder);
		await Promise.all(chunkPaths.map((path) => rm(path, { force: true })));
	}
}

export async function verifyRemuxedRecording(
	videoPath: string,
	audioPath: string | null,
	outputPath: string,
	options: Pick<
		RecordingVerificationOptions,
		"requireAudio" | "abortSignal" | "timeoutMs" | "onProgress"
	>,
	videoChunks?: RecordingVideoChunkSource,
	preverified: PreverifiedVideoRun[] = [],
): Promise<RecordingVerificationResult & { sourcePreserved: true }> {
	const signal = AbortSignal.any([
		...(options.abortSignal ? [options.abortSignal] : []),
		AbortSignal.timeout(options.timeoutMs ?? MAX_LOCAL_VERIFICATION_MS),
	]);
	options = { ...options, abortSignal: signal };
	let proof: Awaited<ReturnType<typeof proveRecordingPackets>>;
	try {
		proof = await proveRecordingPackets(
			videoPath,
			audioPath,
			outputPath,
			signal,
		);
		if (proof.outputTiming.terminalPacketCount !== 1)
			throw new Error("Tied terminal samples require decoded source evidence");
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof RecordingPacketMismatchError) throw error;
		const sourceEvidence = await inspectRecordingSources(
			videoPath,
			audioPath,
			options,
		);
		const result = await verifyRecording(outputPath, {
			...options,
			sourceEvidence,
		});
		if (!result.sourcePreserved)
			throw new Error("Recording source preservation was not verified");
		return { ...result, sourcePreserved: true };
	}
	const decodeOptions = {
		...options,
		timeoutMs: options.timeoutMs ?? MAX_LOCAL_VERIFICATION_MS,
	};
	const chunkCount = verifyDecodeChunks();
	let result: RecordingVerificationResult | undefined;
	if (
		videoChunks &&
		(preverified.length > 0 ||
			(chunkCount > 1 && videoChunks.segments.length >= chunkCount * 2))
	) {
		try {
			result = await decodePacketProvenChunks(
				outputPath,
				videoChunks,
				chunkCount,
				decodeOptions,
				proof,
				preverified,
			);
		} catch (error) {
			signal.throwIfAborted();
			if (
				error instanceof RecordingVerificationError &&
				error.message === "Recording verification timed out"
			)
				throw error;
			console.warn(
				JSON.stringify({
					event: "recording_chunked_decode_fallback",
					reason: (error instanceof Error ? error.message : String(error))
						.replace(/https?:\/\/\S+/g, "<url>")
						.slice(0, 300),
				}),
			);
		}
	}
	result ??= await decodeRecording(
		outputPath,
		decodeOptions,
		undefined,
		undefined,
		proof,
	);
	await proof.assertUnchanged();
	if (
		result.video.frameCount !== proof.videoPackets ||
		Boolean(result.audio) !== proof.hasAudio
	) {
		throw new Error("Recording decoded tracks do not match the encoded source");
	}
	return {
		...result,
		video: {
			...result.video,
			startTime: proof.videoStartTime,
			endTime: proof.videoStartTime + result.video.duration,
		},
		sourcePreserved: true,
	};
}

export async function verifyRecording(
	input: string,
	options: RecordingVerificationOptions,
): Promise<RecordingVerificationResult> {
	return decodeRecording(input, options);
}

async function decodeRecording(
	input: string,
	options: RecordingVerificationOptions,
	objectIdentity?: string,
	sourceAudioInput?: string | null,
	packetProof?: Awaited<ReturnType<typeof proveRecordingPackets>>,
): Promise<RecordingVerificationResult> {
	const startedAt = performance.now();
	const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
	if (
		(options.expectedDuration !== undefined &&
			!positiveNumber(options.expectedDuration)) ||
		(options.expectedDuration === undefined &&
			!options.sourceEvidence &&
			!options.allowObservedDuration &&
			!packetProof &&
			sourceAudioInput === undefined) ||
		!positiveNumber(timeoutMs) ||
		timeoutMs > (packetProof ? MAX_LOCAL_VERIFICATION_MS : PROCESS_TIMEOUT_MS)
	) {
		throw new Error("Invalid recording verification budget or duration");
	}
	if (options.abortSignal?.aborted) {
		throw new Error("Recording verification was cancelled");
	}
	let remote = false;
	if (isAbsolute(input)) {
		const metadata = await lstat(input);
		if (!metadata.isFile()) {
			throw new Error("Recording verification requires a regular MP4 file");
		}
	} else {
		const url = new URL(input);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password
		) {
			throw new Error("Recording verification requires an HTTP(S) MP4 URL");
		}
		remote = true;
	}
	if (sourceAudioInput && !(await lstat(sourceAudioInput)).isFile()) {
		throw new Error("Recording verification requires a regular MP4 file");
	}
	if (options.abortSignal?.aborted) {
		throw new Error("Recording verification was cancelled");
	}
	let videoTiming: RecordingVideoTiming | undefined = packetProof?.outputTiming;
	if (sourceAudioInput !== undefined || options.sourceEvidence) {
		const deadline = new AbortController();
		const remainingMs = timeoutMs - (performance.now() - startedAt);
		if (remainingMs <= 0) {
			throw new RecordingVerificationError(
				"Recording verification timed out",
				true,
			);
		}
		const timeout = setTimeout(() => deadline.abort(), remainingMs);
		const signal = options.abortSignal
			? AbortSignal.any([deadline.signal, options.abortSignal])
			: deadline.signal;
		try {
			const remoteObject = remote
				? await readRemoteIdentity(input, signal, objectIdentity)
				: undefined;
			objectIdentity = remoteObject?.objectIdentity ?? objectIdentity;
			const timingBudgetMs = timeoutMs - (performance.now() - startedAt);
			if (timingBudgetMs <= 0) {
				throw new RecordingVerificationError(
					"Recording verification timed out",
					true,
				);
			}
			videoTiming = await readRecordingVideoTiming(input, {
				remoteObject,
				abortSignal: signal,
				timeoutMs: Math.ceil(timingBudgetMs),
			});
		} catch (error) {
			if (options.abortSignal?.aborted) {
				throw new Error("Recording verification was cancelled");
			}
			if (deadline.signal.aborted) {
				throw new RecordingVerificationError(
					"Recording verification timed out",
					true,
				);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			deadline.abort();
		}
	}
	const decodeBudgetMs = timeoutMs - (performance.now() - startedAt);
	if (decodeBudgetMs <= 0) {
		throw new RecordingVerificationError(
			"Recording verification timed out",
			true,
		);
	}
	const knownAudio = packetProof
		? packetProof.hasAudio
		: sourceAudioInput === undefined
			? options.sourceEvidence
				? Boolean(options.sourceEvidence.audio)
				: options.hasAudio
			: sourceAudioInput !== null;
	const hashContent =
		!packetProof &&
		(options.hashDecodedContent !== false || Boolean(options.sourceEvidence));
	const streamDecodedContent =
		hashContent && process.platform !== "win32" && knownAudio !== undefined;
	if (streamDecodedContent && !Bun.semver.satisfies(Bun.version, ">=1.4.0")) {
		throw new Error(
			"Recording content verification requires Bun 1.4.0 or newer; upgrade the media-server runtime to avoid double-closing decoded-content pipes",
		);
	}
	const hashAudio = Boolean(knownAudio);
	const outputOptions = [
		"-map",
		"0:v:0",
		...(sourceAudioInput === null
			? []
			: ["-map", sourceAudioInput ? "1:a:0" : "0:a:0?"]),
		"-fps_mode",
		"passthrough",
		"-enc_time_base:v",
		"-1",
		"-c:v",
		"rawvideo",
		// Encoded packet proof binds the real timeline; diagnostic frames need monotonic mux timestamps.
		...(packetProof ? ["-bsf:v", "setts=pts=N:dts=N:duration=1"] : []),
		"-c:a",
		"pcm_f64le",
		"-threads",
		"1",
		"-max_interleave_delta",
		"1",
	];
	const proc = registerSubprocess(
		await spawnRecordingDecoder(
			[
				"-hide_banner",
				"-nostdin",
				"-copyts",
				"-v",
				"error",
				"-xerror",
				"-err_detect",
				"explode+crccheck",
				"-filter_threads",
				"1",
				"-filter_complex_threads",
				"1",
				// FFmpeg's H.264/HEVC decoders are bit-exact across thread counts, so decoded hashes do not depend on this.
				"-threads",
				decodeThreadsFromEnv("MEDIA_SERVER_VERIFY_DECODE_THREADS", 1),
				"-protocol_whitelist",
				remote ? "http,https,tcp,tls" : "file",
				"-f",
				"mov",
				...(objectIdentity
					? [
							"-headers",
							`If-Match: ${objectIdentity}\r\nX-Cap-Recording-Verification: 1\r\n`,
						]
					: []),
				"-i",
				input,
				...(sourceAudioInput
					? [
							"-err_detect",
							"explode+crccheck",
							"-threads",
							"1",
							"-protocol_whitelist",
							"file",
							"-f",
							"mov",
							"-i",
							sourceAudioInput,
						]
					: []),
				...outputOptions,
				"-f",
				"framecrc",
				"pipe:1",
				...(streamDecodedContent
					? [
							"-map",
							"0:v:0",
							"-fps_mode",
							"passthrough",
							"-enc_time_base:v",
							"-1",
							"-c:v",
							"rawvideo",
							// Raw bytes have no timestamps; framecrc retains the original timeline.
							"-bsf:v",
							"setts=pts=N:dts=N:duration=1",
							"-threads",
							"1",
							"-max_interleave_delta",
							"1",
							"-f",
							"rawvideo",
							"pipe:3",
							...(hashAudio
								? [
										"-map",
										sourceAudioInput ? "1:a:0" : "0:a:0",
										"-c:a",
										"pcm_f64le",
										"-threads",
										"1",
										"-max_interleave_delta",
										"1",
										"-f",
										"f64le",
										"pipe:4",
									]
								: []),
						]
					: !hashContent
						? []
						: [
								...outputOptions,
								"-f",
								"streamhash",
								"-hash",
								"sha256",
								"pipe:2",
							]),
			],
			streamDecodedContent ? (hashAudio ? 2 : 1) : 0,
		),
	);
	let failure: Error | undefined;
	const stop = () => {
		if (proc.exitCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				failure ??= new Error("Recording decoder termination failed");
			}
		}
	};
	const cancel = () => {
		failure ??= new Error("Recording verification was cancelled");
		stop();
	};
	options.abortSignal?.addEventListener("abort", cancel, { once: true });
	const timeout = setTimeout(() => {
		failure ??= new RecordingVerificationError(
			"Recording verification timed out",
			true,
		);
		stop();
	}, decodeBudgetMs);
	const streams = new Map<number, DecodedStream>();
	let lastDecodedFrames = 0;
	let lastAdvance = performance.now();
	let lastReport = 0;
	const progress = () => {
		const count = streams.get(0)?.frameCount ?? 0;
		const decodedFrames = [...streams.values()].reduce(
			(total, stream) => total + stream.frameCount,
			0,
		);
		if (decodedFrames > lastDecodedFrames) {
			lastDecodedFrames = decodedFrames;
			lastAdvance = performance.now();
		}
		if (performance.now() - lastReport >= 1000) {
			lastReport = performance.now();
			options.onProgress?.({
				frames: count,
				totalFrames: packetProof?.videoPackets,
			});
		}
	};
	const stall = packetProof
		? setInterval(() => {
				if (performance.now() - lastAdvance > DECODER_STALL_MS) {
					failure ??= new RecordingVerificationError(
						"Recording decoder stopped making progress",
						true,
					);
					stop();
				}
			}, 1000)
		: undefined;
	const frames = readFrameEvidence(
		proc.stdout,
		streams,
		videoTiming !== undefined,
		progress,
	);
	const errors = readDecoderErrors(proc.stderr, input);
	frames.catch(stop);
	errors.catch(stop);
	const pipes: Readable[] = [];
	const hashes: ReturnType<typeof hashDecodedStream>[] = [];
	let result: RecordingVerificationResult;
	try {
		if (streamDecodedContent) {
			for (const stream of proc.stdio.slice(3)) {
				if (!(stream instanceof Readable)) {
					throw new Error("Decoded recording pipe is unavailable");
				}
				pipes.push(stream);
			}
			if (pipes.length !== (hashAudio ? 2 : 1)) {
				throw new Error("Decoded recording pipe is missing");
			}
			for (const stream of pipes) {
				const hash = hashDecodedStream(stream);
				hash.catch(stop);
				hashes.push(hash);
			}
		}
		if (options.abortSignal?.aborted) cancel();
		const [, diagnostics, exitCode, content] = await Promise.all([
			frames,
			errors,
			proc.exited,
			Promise.all(hashes),
		]);
		const stderr = diagnostics.error;
		if (failure) throw failure;
		if (exitCode !== 0 || stderr || proc.signalCode) {
			throw new RecordingVerificationError(
				`Recording full decode failed: ${stderr || exitCode}`,
				Boolean(proc.signalCode) ||
					/HTTP error (?:408|429|5\d\d)\b|Server returned (?:408|429|5\d\d|5XX)\b|Connection reset by peer|Connection timed out|Connection refused|Network is unreachable|Temporary failure in name resolution|Cannot allocate memory|Resource temporarily unavailable|No space left on device/i.test(
						stderr,
					),
			);
		}
		if (streamDecodedContent) {
			if (diagnostics.digests.length !== 0) {
				throw new Error("Unexpected decoded recording content digest");
			}
			for (const [index, digest] of content.entries()) {
				const stream = streams.get(index);
				if (
					!stream ||
					digest.bytes === 0 ||
					digest.bytes !== stream.decodedBytes
				) {
					throw new Error("Decoded recording content is incomplete");
				}
				stream.contentSha256 = digest.sha256;
			}
		} else if (hashContent) {
			for (const digest of diagnostics.digests) decodeLine(digest, streams);
		}
		result = validateEvidence(
			streams,
			options,
			sourceAudioInput !== undefined || packetProof !== undefined,
			videoTiming,
			hashContent,
		);
	} catch (error) {
		throw failure ?? error;
	} finally {
		clearTimeout(timeout);
		if (stall) clearInterval(stall);
		options.abortSignal?.removeEventListener("abort", cancel);
		stop();
		await Promise.allSettled([proc.exited, frames, errors, ...hashes]);
		unregisterSubprocess(proc);
	}
	if (failure) throw failure;
	if (options.abortSignal?.aborted) {
		throw new Error("Recording verification was cancelled");
	}
	return result;
}

function isStrongObjectIdentity(value: string | null): value is string {
	return (
		value !== null &&
		value.length <= 1_024 &&
		/^"[\x21\x23-\x7E\x80-\xFF]+"$/.test(value)
	);
}

async function readRemoteIdentity(
	input: string,
	abortSignal: AbortSignal,
	expectedObjectIdentity?: string,
): Promise<{ objectIdentity: string; fileSize: number }> {
	const headers: Record<string, string> = {
		Range: "bytes=0-0",
		"X-Cap-Recording-Verification": "1",
	};
	if (expectedObjectIdentity) headers["If-Match"] = expectedObjectIdentity;
	let response: Response;
	try {
		response = await fetchMedia(input, { headers, signal: abortSignal });
	} catch {
		throw new RecordingVerificationError(
			"Recording object identity could not be read",
			true,
		);
	}
	try {
		if (response.status === 412) {
			throw new Error("Recording object changed during verification");
		}
		if (response.status !== 200 && response.status !== 206) {
			throw new RecordingVerificationError(
				`Recording object identity read failed: ${response.status}`,
				response.status === 408 ||
					response.status === 429 ||
					response.status >= 500,
			);
		}
		const objectIdentity = response.headers.get("etag");
		if (!isStrongObjectIdentity(objectIdentity)) {
			throw new Error(
				"Recording storage does not expose a strong object identity",
			);
		}
		if (expectedObjectIdentity && expectedObjectIdentity !== objectIdentity) {
			throw new Error("Recording object changed during verification");
		}
		const range = response.headers.get("content-range");
		const length =
			response.status === 206
				? range?.match(/^bytes 0-0\/(\d+)$/)?.[1]
				: response.headers.get("content-length");
		const fileSize = Number(length);
		if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
			throw new Error(
				"Recording storage does not expose the complete object size",
			);
		}
		return { objectIdentity, fileSize };
	} finally {
		await response.body?.cancel();
	}
}

const DEFAULT_RANGED_VERIFY_PART_MB = 16;

export function verifyDownloadConcurrency(
	env: Record<string, string | undefined> = process.env,
): number {
	const value = Number(env.MEDIA_SERVER_VERIFY_DOWNLOAD_CONCURRENCY?.trim());
	return Number.isInteger(value) && value > 1 ? Math.min(value, 16) : 1;
}

export function verifyDownloadPartBytes(
	env: Record<string, string | undefined> = process.env,
): number {
	const value = Number(env.MEDIA_SERVER_VERIFY_DOWNLOAD_PART_MB?.trim());
	const megabytes =
		Number.isInteger(value) && value >= 1 && value <= 64
			? value
			: DEFAULT_RANGED_VERIFY_PART_MB;
	return megabytes * 1024 * 1024;
}

class RangedVerificationUnsupported extends Error {}

// Same proof as the sequential read (every byte, hashed in order, pinned to one
// ETag), fetched as concurrent ranges so large uploads re-read at network speed.
async function hashRemoteRecordingRanged(
	input: string,
	objectIdentity: string,
	fileSize: number,
	abortSignal: AbortSignal,
	concurrency: number,
	partBytes: number,
): Promise<string> {
	const reads = new AbortController();
	const signal = AbortSignal.any([abortSignal, reads.signal]);
	const partCount = Math.ceil(fileSize / partBytes);
	const readPart = async (index: number): Promise<Uint8Array> => {
		const start = index * partBytes;
		const end = Math.min(fileSize, start + partBytes) - 1;
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			let response: Response | undefined;
			try {
				try {
					response = await fetchMedia(input, {
						headers: {
							"If-Match": objectIdentity,
							"X-Cap-Recording-Verification": "1",
							Range: `bytes=${start}-${end}`,
						},
						signal,
					});
				} catch (error) {
					if (error instanceof MediaTransferBudgetError) throw error;
					throw new RecordingVerificationError(
						"Recording bytes could not be read",
						true,
					);
				}
				if (response.status === 200) throw new RangedVerificationUnsupported();
				if (response.status !== 206) {
					throw new RecordingVerificationError(
						`Recording byte verification failed: ${response.status}`,
						response.status === 408 ||
							response.status === 429 ||
							response.status >= 500,
					);
				}
				if (response.headers.get("etag") !== objectIdentity || !response.body)
					throw new Error("Recording object changed during byte verification");
				if (
					response.headers.get("content-range") !==
					`bytes ${start}-${end}/${fileSize}`
				)
					throw new Error(
						"Recording byte resume range does not match the verified object",
					);
				const expected = end - start + 1;
				const bytes = new Uint8Array(expected);
				let received = 0;
				try {
					for await (const chunk of response.body) {
						if (received + chunk.byteLength > expected)
							throw new RecordingVerificationError(
								"Recording object size changed during byte verification",
								false,
							);
						bytes.set(chunk, received);
						received += chunk.byteLength;
					}
				} catch (error) {
					if (error instanceof RecordingVerificationError) throw error;
					throw new RecordingVerificationError(
						"Recording bytes could not be read completely",
						true,
					);
				}
				if (received !== expected)
					throw new RecordingVerificationError(
						"Recording bytes could not be read completely",
						true,
					);
				return bytes;
			} catch (error) {
				signal.throwIfAborted();
				if (
					!(error instanceof RecordingVerificationError) ||
					!error.retryable ||
					attempt >= 3
				)
					throw error;
			} finally {
				if (!response?.body?.locked)
					await response?.body?.cancel().catch(() => {});
			}
			await sleep(250 * 2 ** attempt, undefined, { signal });
		}
	};
	const hash = createHash("sha256");
	const inFlight = new Map<number, Promise<Uint8Array>>();
	let requested = 0;
	try {
		for (let index = 0; index < partCount; index++) {
			while (requested < partCount && requested < index + concurrency) {
				const part = readPart(requested);
				part.catch(() => {});
				inFlight.set(requested, part);
				requested++;
			}
			const bytes = await inFlight.get(index);
			inFlight.delete(index);
			if (!bytes) throw new Error("Recording byte range was not requested");
			hash.update(bytes);
		}
		return hash.digest("hex");
	} finally {
		reads.abort();
		await Promise.allSettled(inFlight.values());
	}
}

async function hashRemoteRecording(
	input: string,
	objectIdentity: string,
	fileSize: number,
	abortSignal: AbortSignal,
): Promise<string> {
	const concurrency = verifyDownloadConcurrency();
	const partBytes = verifyDownloadPartBytes();
	if (concurrency > 1 && fileSize > partBytes) {
		try {
			return await hashRemoteRecordingRanged(
				input,
				objectIdentity,
				fileSize,
				abortSignal,
				concurrency,
				partBytes,
			);
		} catch (error) {
			if (!(error instanceof RangedVerificationUnsupported)) throw error;
		}
	}
	const hash = createHash("sha256");
	let bytesRead = 0;
	for (let attempt = 0; ; attempt++) {
		abortSignal.throwIfAborted();
		let response: Response | undefined;
		try {
			const offset = bytesRead;
			try {
				response = await fetchMedia(input, {
					headers: {
						"If-Match": objectIdentity,
						"X-Cap-Recording-Verification": "1",
						...(offset > 0 ? { Range: `bytes=${offset}-${fileSize - 1}` } : {}),
					},
					signal: abortSignal,
				});
			} catch (error) {
				if (error instanceof MediaTransferBudgetError) throw error;
				throw new RecordingVerificationError(
					"Recording bytes could not be read",
					true,
				);
			}
			if (offset > 0 && response.status === 200)
				throw new Error(
					"Recording object size changed during byte verification: resume range ignored",
				);
			if (response.status !== (offset > 0 ? 206 : 200)) {
				throw new RecordingVerificationError(
					`Recording byte verification failed: ${response.status}`,
					response.status === 408 ||
						response.status === 429 ||
						response.status >= 500,
				);
			}
			if (response.headers.get("etag") !== objectIdentity || !response.body)
				throw new Error("Recording object changed during byte verification");
			if (
				offset > 0 &&
				response.headers.get("content-range") !==
					`bytes ${offset}-${fileSize - 1}/${fileSize}`
			)
				throw new Error(
					"Recording byte resume range does not match the verified object",
				);
			try {
				for await (const chunk of response.body) {
					if (bytesRead + chunk.byteLength > fileSize)
						throw new RecordingVerificationError(
							"Recording object size changed during byte verification",
							false,
						);
					hash.update(chunk);
					bytesRead += chunk.byteLength;
				}
			} catch (error) {
				if (error instanceof RecordingVerificationError) throw error;
				throw new RecordingVerificationError(
					"Recording bytes could not be read completely",
					true,
				);
			}
			if (bytesRead !== fileSize)
				throw new RecordingVerificationError(
					"Recording object size changed during byte verification",
					true,
				);
			return hash.digest("hex");
		} catch (error) {
			abortSignal.throwIfAborted();
			if (
				!(error instanceof RecordingVerificationError) ||
				!error.retryable ||
				attempt >= 3 ||
				bytesRead >= fileSize
			)
				throw error;
		} finally {
			if (!response?.body?.locked)
				await response?.body?.cancel().catch(() => {});
		}
		await sleep(250 * 2 ** attempt, undefined, { signal: abortSignal });
	}
}

export async function verifyRemoteRecording(
	input: string,
	options: RemoteRecordingVerificationOptions,
): Promise<RemoteRecordingVerificationResult> {
	const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > PROCESS_TIMEOUT_MS ||
		(options.expectedDuration !== undefined &&
			!positiveNumber(options.expectedDuration)) ||
		(options.expectedDuration === undefined &&
			!options.sourceEvidence &&
			!options.allowObservedDuration) ||
		(options.expectedFileSize !== undefined &&
			(!Number.isSafeInteger(options.expectedFileSize) ||
				options.expectedFileSize <= 0)) ||
		(options.expectedSha256 !== undefined &&
			!/^[a-f0-9]{64}$/.test(options.expectedSha256))
	) {
		throw new Error("Invalid recording verification budget or duration");
	}
	const url = new URL(input);
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password
	) {
		throw new Error(
			"Remote recording verification requires an HTTP(S) MP4 URL",
		);
	}
	if (
		options.expectedObjectIdentity !== undefined &&
		!isStrongObjectIdentity(options.expectedObjectIdentity)
	) {
		throw new Error(
			"Recording storage does not expose a strong object identity",
		);
	}
	const deadline = new AbortController();
	const startedAt = performance.now();
	const timeout = setTimeout(() => deadline.abort(), timeoutMs);
	const signal = options.abortSignal
		? AbortSignal.any([deadline.signal, options.abortSignal])
		: deadline.signal;
	try {
		if (signal.aborted) throw new Error("Recording verification was cancelled");
		const before = await readRemoteIdentity(
			input,
			signal,
			options.expectedObjectIdentity,
		);
		if (
			options.expectedFileSize !== undefined &&
			before.fileSize !== options.expectedFileSize
		) {
			throw new Error("Uploaded recording size does not match the muxed file");
		}
		const remainingMs = timeoutMs - (performance.now() - startedAt);
		if (remainingMs <= 0) {
			throw new RecordingVerificationError(
				"Recording verification timed out",
				true,
			);
		}
		const local = await materializeMedia(input, signal, before.objectIdentity);
		const evidence = await decodeRecording(
			local?.path ?? input,
			{ ...options, abortSignal: signal, timeoutMs: remainingMs },
			local ? undefined : before.objectIdentity,
		);
		const remoteSha256 =
			options.expectedSha256 || options.hashContent
				? await hashRemoteRecording(
						input,
						before.objectIdentity,
						before.fileSize,
						signal,
					)
				: undefined;
		if (options.expectedSha256 && remoteSha256 !== options.expectedSha256) {
			throw new Error("Uploaded recording bytes do not match the muxed file");
		}
		const after = await readRemoteIdentity(
			input,
			signal,
			before.objectIdentity,
		);
		if (before.fileSize !== after.fileSize) {
			throw new Error("Recording object changed during verification");
		}
		if (signal.aborted) throw new Error("Recording verification was cancelled");
		return { ...evidence, ...after, ...(remoteSha256 ? { remoteSha256 } : {}) };
	} catch (error) {
		if (options.abortSignal?.aborted) {
			throw new Error("Recording verification was cancelled");
		}
		if (deadline.signal.aborted) {
			throw new RecordingVerificationError(
				"Recording verification timed out",
				true,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export async function verifyRemoteRecordingBytes(
	input: string,
	options: RemoteRecordingBytesOptions,
): Promise<RemoteRecordingBytesResult> {
	const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > PROCESS_TIMEOUT_MS ||
		!Number.isSafeInteger(options.expectedFileSize) ||
		options.expectedFileSize <= 0 ||
		!/^[a-f0-9]{64}$/.test(options.expectedSha256) ||
		!isStrongObjectIdentity(options.expectedObjectIdentity)
	) {
		throw new Error("Invalid recording byte verification expectations");
	}
	const url = new URL(input);
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password
	) {
		throw new Error(
			"Remote recording verification requires an HTTP(S) MP4 URL",
		);
	}
	const deadline = new AbortController();
	const timeout = setTimeout(() => deadline.abort(), timeoutMs);
	const signal = options.abortSignal
		? AbortSignal.any([deadline.signal, options.abortSignal])
		: deadline.signal;
	try {
		if (signal.aborted) throw new Error("Recording verification was cancelled");
		const before = await readRemoteIdentity(
			input,
			signal,
			options.expectedObjectIdentity,
		);
		if (before.fileSize !== options.expectedFileSize) {
			throw new Error("Uploaded recording size does not match the muxed file");
		}
		const remoteSha256 = await hashRemoteRecording(
			input,
			before.objectIdentity,
			before.fileSize,
			signal,
		);
		if (remoteSha256 !== options.expectedSha256) {
			throw new Error("Uploaded recording bytes do not match the muxed file");
		}
		const after = await readRemoteIdentity(
			input,
			signal,
			before.objectIdentity,
		);
		if (before.fileSize !== after.fileSize) {
			throw new Error("Recording object changed during verification");
		}
		if (signal.aborted) throw new Error("Recording verification was cancelled");
		return { ...after, remoteSha256 };
	} catch (error) {
		if (options.abortSignal?.aborted) {
			throw new Error("Recording verification was cancelled");
		}
		if (deadline.signal.aborted) {
			throw new RecordingVerificationError(
				"Recording verification timed out",
				true,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export async function hashRecordingFile(
	input: string,
	abortSignal?: AbortSignal,
): Promise<string> {
	if (!isAbsolute(input) || !(await lstat(input)).isFile()) {
		throw new Error("Recording hashing requires a local regular file");
	}
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(input, { signal: abortSignal })) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}
