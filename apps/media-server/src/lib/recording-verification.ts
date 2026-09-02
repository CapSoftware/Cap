import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "bun";
import { PROCESS_TIMEOUT_MS } from "./media-common";
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
	return error instanceof RecordingVerificationError && error.retryable;
}

export interface RecordingVerificationOptions {
	expectedDuration: number;
	requireAudio: boolean;
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
}

export interface RemoteRecordingVerificationOptions
	extends RecordingVerificationOptions {
	expectedObjectIdentity?: string;
}

export interface RemoteRecordingVerificationResult
	extends RecordingVerificationResult {
	objectIdentity: string;
	fileSize: number;
}

interface DecodedStream {
	kind?: "video" | "audio";
	timeBase?: number;
	sampleRate?: number;
	frameCount: number;
	sampleCount: number;
	startTime: number;
	endTime: number;
	previousTime: number;
	maximumGap: number;
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

function decodeLine(line: string, streams: Map<number, DecodedStream>): void {
	if (!line) return;
	const metadata = line.match(/^#(tb|media_type|sample_rate) (\d+):\s*(.+)$/);
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
		} else if (metadata[1] === "media_type") {
			if (metadata[3] !== "video" && metadata[3] !== "audio") {
				throw new Error("Invalid decoded recording stream type");
			}
			stream.kind = metadata[3];
		} else {
			stream.sampleRate = Number(metadata[3]);
			if (!Number.isSafeInteger(stream.sampleRate) || stream.sampleRate <= 0) {
				throw new Error("Invalid decoded recording sample rate");
			}
		}
		return;
	}
	if (line.startsWith("#")) return;
	const columns = line.split(",").map((value) => value.trim());
	const [index, dts, pts, ticks, bytes] = columns.slice(0, 5).map(Number);
	if (
		columns.length < 6 ||
		![index, dts, pts, ticks, bytes].every(Number.isSafeInteger) ||
		!/^[a-f0-9]{8}$/i.test(columns[5]) ||
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
	if (!Number.isFinite(endTime) || startTime <= stream.previousTime) {
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
		stream.sampleCount += Math.round(samples);
	}
}

async function readFrameEvidence(
	stream: ReadableStream<Uint8Array>,
	streams: Map<number, DecodedStream>,
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
			decodeLine(pending.slice(0, newline).trim(), streams);
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
		if (pending.length > MAX_OUTPUT_LINE_LENGTH) {
			throw new Error("Recording decoder output exceeded its limit");
		}
	}
	pending += decoder.decode();
	decodeLine(pending.trim(), streams);
}

async function readDecoderErrors(
	stream: ReadableStream<Uint8Array>,
	input: string,
): Promise<string> {
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
	return (
		output
			.replaceAll(input, "<recording input>")
			.replace(/https?:\/\/\S+/g, "<redacted URL>")
			.trim()
			.slice(-MAX_ERROR_LENGTH) ||
		(truncated ? "Decoder error output exceeded its limit" : "")
	);
}

function validateEvidence(
	streams: Map<number, DecodedStream>,
	options: RecordingVerificationOptions,
): RecordingVerificationResult {
	const video = streams.get(0);
	const audio = streams.get(1);
	if (video?.kind !== "video" || video.frameCount === 0) {
		throw new Error("Recording has no decoded video frames");
	}
	const videoEvidence = streamEvidence(video);
	const durationTolerance = Math.max(
		0.5,
		Math.min(5, options.expectedDuration * 0.01),
	);
	if (
		Math.abs(videoEvidence.duration - options.expectedDuration) >
		durationTolerance
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
	if (options.requireAudio) {
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
	return { fullDecode: true, video: videoEvidence, audio: audioEvidence };
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
): Promise<RecordingVerificationResult> {
	const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
	if (
		!positiveNumber(options.expectedDuration) ||
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
	if (options.abortSignal?.aborted) {
		throw new Error("Recording verification was cancelled");
	}
	const proc = registerSubprocess(
		spawn({
			cmd: [
				"ffmpeg",
				"-hide_banner",
				"-nostdin",
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
				"-map",
				"0:v:0",
				"-map",
				"0:a:0?",
				"-fps_mode",
				"passthrough",
				"-enc_time_base:v",
				"-1",
				"-c:v",
				"rawvideo",
				"-c:a",
				"pcm_s16le",
				"-threads",
				"1",
				"-f",
				"framehash",
				"-hash",
				"adler32",
				"-",
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
	}, timeoutMs);
	const streams = new Map<number, DecodedStream>();
	const frames = readFrameEvidence(proc.stdout, streams);
	const errors = readDecoderErrors(proc.stderr, input);
	let result: RecordingVerificationResult;
	try {
		if (options.abortSignal?.aborted) cancel();
		const [, stderr, exitCode] = await Promise.all([
			frames,
			errors,
			proc.exited,
		]);
		if (failure) throw failure;
		if (exitCode !== 0 || stderr || proc.signalCode) {
			throw new RecordingVerificationError(
				`Recording full decode failed: ${stderr || exitCode}`,
				/HTTP error (?:408|429|5\d\d)\b|Server returned (?:408|429|5\d\d|5XX)\b|Connection reset by peer|Connection timed out|Connection refused|Network is unreachable|Temporary failure in name resolution/i.test(
					stderr,
				),
			);
		}
		result = validateEvidence(streams, options);
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

export async function verifyRemoteRecording(
	input: string,
	options: RemoteRecordingVerificationOptions,
): Promise<RemoteRecordingVerificationResult> {
	const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > PROCESS_TIMEOUT_MS ||
		!positiveNumber(options.expectedDuration)
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
		const after = await readRemoteIdentity(
			input,
			signal,
			before.objectIdentity,
		);
		if (before.fileSize !== after.fileSize) {
			throw new Error("Recording object changed during verification");
		}
		if (signal.aborted) throw new Error("Recording verification was cancelled");
		return { ...evidence, ...after };
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
