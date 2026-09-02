import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "bun";
import { PROCESS_TIMEOUT_MS } from "./media-common";
import {
	RecordingTimingError,
	type RecordingVideoTiming,
	readRecordingVideoTiming,
} from "./recording-timing";
import { registerSubprocess, unregisterSubprocess } from "./subprocess";

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
	sourceEvidence?: RecordingSourceEvidence;
	allowObservedDuration?: boolean;
	abortSignal?: AbortSignal;
	timeoutMs?: number;
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
	if (
		(timing.lastTimestampTicks - timing.firstTimestampTicks) *
			timeBaseDenominator !==
			(lastVideoPts - firstVideoPts) * timeBaseNumerator * timeScale ||
		timing.videoPacketCount !== stream.frameCount ||
		timing.terminalPacketCount !== stream.terminalVideoFrameCount
	) {
		throw new Error("Recording container timing does not match decoded video");
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
	stream: ReadableStream<Uint8Array>,
	streams: Map<number, DecodedStream>,
	allowVideoTies: boolean,
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
		if (pending.length > MAX_OUTPUT_LINE_LENGTH) {
			throw new Error("Recording decoder output exceeded its limit");
		}
	}
	pending += decoder.decode();
	decodeLine(pending.trim(), streams, allowVideoTies);
}

async function readDecoderErrors(
	stream: ReadableStream<Uint8Array>,
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

function validateEvidence(
	streams: Map<number, DecodedStream>,
	options: RecordingVerificationOptions,
	inspectingSource: boolean,
	videoTiming: RecordingVideoTiming | undefined,
): RecordingSourceEvidence {
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
	const result: RecordingSourceEvidence = {
		fullDecode: true,
		video: videoEvidence,
		audio: audioEvidence,
		integrity: {
			video: integrity(video),
			audio: audioEvidence && audio ? integrity(audio) : null,
		},
	};
	if (options.sourceEvidence) {
		assertSourcePreserved(options.sourceEvidence, result);
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
	return decodeRecording(
		videoInputPath,
		{ ...options, requireAudio: audioInputPath !== null },
		undefined,
		audioInputPath,
	);
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
): Promise<RecordingSourceEvidence> {
	const startedAt = performance.now();
	const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
	if (
		(options.expectedDuration !== undefined &&
			!positiveNumber(options.expectedDuration)) ||
		(options.expectedDuration === undefined &&
			!options.sourceEvidence &&
			!options.allowObservedDuration &&
			sourceAudioInput === undefined) ||
		!positiveNumber(timeoutMs) ||
		timeoutMs > PROCESS_TIMEOUT_MS
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
	let videoTiming: RecordingVideoTiming | undefined;
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
		"-c:a",
		"pcm_f64le",
		"-threads",
		"1",
		"-max_interleave_delta",
		"1",
	];
	const proc = registerSubprocess(
		spawn({
			cmd: [
				"ffmpeg",
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
				"-threads",
				"1",
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
				...outputOptions,
				"-f",
				"streamhash",
				"-hash",
				"sha256",
				"pipe:2",
			],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
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
	const frames = readFrameEvidence(
		proc.stdout,
		streams,
		videoTiming !== undefined,
	);
	const errors = readDecoderErrors(proc.stderr, input);
	let result: RecordingSourceEvidence;
	try {
		if (options.abortSignal?.aborted) cancel();
		const [, diagnostics, exitCode] = await Promise.all([
			frames,
			errors,
			proc.exited,
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
		for (const digest of diagnostics.digests) decodeLine(digest, streams);
		result = validateEvidence(
			streams,
			options,
			sourceAudioInput !== undefined,
			videoTiming,
		);
	} finally {
		clearTimeout(timeout);
		options.abortSignal?.removeEventListener("abort", cancel);
		stop();
		await proc.exited;
		await Promise.allSettled([frames, errors]);
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
		response = await fetch(input, { headers, signal: abortSignal });
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

async function hashRemoteRecording(
	input: string,
	objectIdentity: string,
	fileSize: number,
	abortSignal: AbortSignal,
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(input, {
			headers: {
				"If-Match": objectIdentity,
				"X-Cap-Recording-Verification": "1",
			},
			signal: abortSignal,
		});
	} catch {
		throw new RecordingVerificationError(
			"Recording bytes could not be read",
			true,
		);
	}
	try {
		if (response.status !== 200) {
			throw new RecordingVerificationError(
				`Recording byte verification failed: ${response.status}`,
				response.status === 408 ||
					response.status === 429 ||
					response.status >= 500,
			);
		}
		if (response.headers.get("etag") !== objectIdentity || !response.body) {
			throw new Error("Recording object changed during byte verification");
		}
		const hash = createHash("sha256");
		let bytesRead = 0;
		try {
			for await (const chunk of response.body) {
				bytesRead += chunk.byteLength;
				if (bytesRead > fileSize) {
					throw new RecordingVerificationError(
						"Recording object size changed during byte verification",
						false,
					);
				}
				hash.update(chunk);
			}
		} catch (error) {
			if (error instanceof RecordingVerificationError) throw error;
			throw new RecordingVerificationError(
				"Recording bytes could not be read completely",
				true,
			);
		}
		if (bytesRead !== fileSize) {
			throw new Error("Recording object size changed during byte verification");
		}
		return hash.digest("hex");
	} finally {
		if (!response.body?.locked) await response.body?.cancel().catch(() => {});
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
		const evidence = await decodeRecording(
			input,
			{ ...options, abortSignal: signal, timeoutMs: remainingMs },
			before.objectIdentity,
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
