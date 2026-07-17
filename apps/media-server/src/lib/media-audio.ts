import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { withTimeout } from "./media-common";
import {
	canAcceptNewAudioOperation,
	getActiveAudioOperationCount,
	registerMediaOperation,
	unregisterMediaOperation,
	withMediaOperation,
} from "./media-operations";
import { materializeStreamingInput } from "./media-video";
import { registerSubprocess, terminateProcess } from "./subprocess";
import { ensureTempDir, getTempDir } from "./temp-files";

export interface AudioExtractionOptions {
	format?: "mp3";
	codec?: "libmp3lame";
	bitrate?: string;
	timeoutMs?: number;
}

export interface StreamingExtractResult {
	stream: ReadableStream<Uint8Array>;
	cleanup: () => void;
}

const CHECK_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const AUDIO_PROBE_MAX_ATTEMPTS = 3;
const AUDIO_PROBE_RETRY_BASE_MS = 250;

const DEFAULT_OPTIONS: Required<AudioExtractionOptions> = {
	format: "mp3",
	codec: "libmp3lame",
	bitrate: "128k",
	timeoutMs: EXTRACT_TIMEOUT_MS,
};

export { canAcceptNewAudioOperation, getActiveAudioOperationCount };

export const canAcceptNewProcess = canAcceptNewAudioOperation;
export const getActiveProcessCount = getActiveAudioOperationCount;

async function drainStream(
	stream: ReadableStream<Uint8Array> | null,
): Promise<void> {
	if (!stream) return;
	try {
		const reader = stream.getReader();
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
		reader.releaseLock();
	} catch {}
}

async function readStreamWithLimit(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (totalBytes < maxBytes) {
				const remainingBytes = maxBytes - totalBytes;
				const chunk =
					value.length > remainingBytes
						? value.slice(0, remainingBytes)
						: value;
				chunks.push(chunk);
				totalBytes += chunk.length;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const decoder = new TextDecoder();
	return chunks
		.map((chunk) => decoder.decode(chunk, { stream: true }))
		.join("");
}

function redactUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol === "file:") {
			return url.pathname;
		}
		return `${url.origin}${url.pathname}`;
	} catch {
		return value.split("?")[0] ?? value;
	}
}

function redactProcessOutput(output: string, url: string): string {
	return output
		.split(url)
		.join(redactUrl(url))
		.replace(/https?:\/\/[^\s"'<>]+/g, redactUrl);
}

function getAudioExtractArgs(
	videoUrl: string,
	options: Required<AudioExtractionOptions>,
): string[] {
	return [
		"ffmpeg",
		"-i",
		videoUrl,
		"-vn",
		"-acodec",
		options.codec,
		"-b:a",
		options.bitrate,
		"-f",
		"mp3",
		"pipe:1",
	];
}

function getAudioProbeArgs(inputPath: string): string[] {
	const normalizedPath = (inputPath.split("?")[0] ?? "").toLowerCase();
	const args = ["ffprobe", "-v", "error"];
	if (normalizedPath.endsWith(".m3u8") || normalizedPath.endsWith(".mpd")) {
		args.push("-protocol_whitelist", "file,http,https,tcp,tls,crypto,data");
	}
	if (normalizedPath.endsWith(".m3u8")) {
		args.push(
			"-allowed_extensions",
			"ALL",
			"-allowed_segment_extensions",
			"ALL",
			"-extension_picky",
			"0",
		);
	}
	args.push("-show_entries", "stream=codec_type", "-of", "csv=p=0", inputPath);
	return args;
}

function isRemoteStreamingUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const pathname = url.pathname.toLowerCase();
		return pathname.endsWith(".m3u8") || pathname.endsWith(".mpd");
	} catch {
		return false;
	}
}

async function prepareAudioProbeInput(
	videoUrl: string,
	abortSignal: AbortSignal,
): Promise<{ inputPath: string; cleanup: () => Promise<void> }> {
	if (!isRemoteStreamingUrl(videoUrl)) {
		return { inputPath: videoUrl, cleanup: async () => {} };
	}

	await ensureTempDir();
	const dirPath = await mkdtemp(join(getTempDir(), "audio-probe-"));
	try {
		const inputPath = await materializeStreamingInput(
			videoUrl,
			dirPath,
			abortSignal,
		);
		return {
			inputPath,
			cleanup: async () => {
				await rm(dirPath, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(dirPath, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

async function probeAudioTracks(
	inputPath: string,
	sourceUrl: string,
	setCurrentCancel: (cancel: () => Promise<void> | void) => void,
	isCancelled: () => boolean,
): Promise<boolean> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < AUDIO_PROBE_MAX_ATTEMPTS; attempt++) {
		if (isCancelled()) {
			throw new Error("Audio probe cancelled");
		}

		const proc = registerSubprocess(
			spawn({
				cmd: getAudioProbeArgs(inputPath),
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		setCurrentCancel(() => terminateProcess(proc));

		try {
			const [stdoutText, stderrText, exitCode] = await Promise.all([
				readStreamWithLimit(
					proc.stdout as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				),
				readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				),
				proc.exited,
			]);
			const safeStderrText = redactProcessOutput(stderrText, sourceUrl);

			if (exitCode === 0) {
				const trackTypes = stdoutText
					.split(/\r?\n/)
					.map((value) => value.trim())
					.filter(Boolean);
				if (!trackTypes.includes("video")) {
					throw new Error("No video stream found");
				}
				return trackTypes.includes("audio");
			}

			lastError = new Error(
				`FFprobe exited with code ${exitCode}: ${safeStderrText}`,
			);
		} finally {
			await terminateProcess(proc);
		}

		if (attempt < AUDIO_PROBE_MAX_ATTEMPTS - 1) {
			await Bun.sleep(AUDIO_PROBE_RETRY_BASE_MS * 2 ** attempt);
		}
	}

	throw lastError ?? new Error("FFprobe could not inspect the video");
}

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	if (!canAcceptNewAudioOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("audio", async (setCancel) => {
		let cancelled = false;
		let cancelCurrent: () => Promise<void> | void = () => {};
		let cleanupInput: () => Promise<void> = async () => {};
		const abortController = new AbortController();
		const cancel = async () => {
			cancelled = true;
			abortController.abort();
			await cancelCurrent();
			await cleanupInput();
		};
		setCancel(cancel);
		return await withTimeout(
			(async () => {
				const preparedInput = await prepareAudioProbeInput(
					videoUrl,
					abortController.signal,
				);
				cleanupInput = preparedInput.cleanup;
				try {
					return await probeAudioTracks(
						preparedInput.inputPath,
						videoUrl,
						(nextCancel) => {
							cancelCurrent = nextCancel;
						},
						() => cancelled,
					);
				} finally {
					await cleanupInput();
				}
			})(),
			CHECK_TIMEOUT_MS,
			cancel,
		);
	});
}

export async function extractAudio(
	videoUrl: string,
	options: AudioExtractionOptions = {},
): Promise<Uint8Array> {
	if (!canAcceptNewAudioOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	const opts = { ...DEFAULT_OPTIONS, ...options };

	return await withMediaOperation("audio", async (setCancel) => {
		const proc = registerSubprocess(
			spawn({
				cmd: getAudioExtractArgs(videoUrl, opts),
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		setCancel(() => terminateProcess(proc));

		try {
			return await withTimeout(
				(async () => {
					const stderrPromise = readStreamWithLimit(
						proc.stderr as ReadableStream<Uint8Array>,
						MAX_STDERR_BYTES,
					);

					const chunks: Uint8Array[] = [];
					let totalBytes = 0;
					const reader = (
						proc.stdout as ReadableStream<Uint8Array>
					).getReader();

					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;

							totalBytes += value.length;
							if (totalBytes > MAX_AUDIO_SIZE_BYTES) {
								reader.releaseLock();
								throw new Error(
									`Audio too large: exceeds ${MAX_AUDIO_SIZE_BYTES} byte limit`,
								);
							}
							chunks.push(value);
						}
					} finally {
						reader.releaseLock();
					}

					const [stderrText, exitCode] = await Promise.all([
						stderrPromise,
						proc.exited,
					]);
					const safeStderrText = redactProcessOutput(stderrText, videoUrl);

					if (exitCode !== 0) {
						throw new Error(
							`FFmpeg exited with code ${exitCode}: ${safeStderrText}`,
						);
					}

					const output = new Uint8Array(totalBytes);
					let offset = 0;
					for (const chunk of chunks) {
						output.set(chunk, offset);
						offset += chunk.length;
					}

					return output;
				})(),
				opts.timeoutMs,
				() => terminateProcess(proc),
			);
		} finally {
			await terminateProcess(proc);
		}
	});
}

export function extractAudioStream(
	videoUrl: string,
	options: AudioExtractionOptions = {},
): StreamingExtractResult {
	if (!canAcceptNewAudioOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	const opts = { ...DEFAULT_OPTIONS, ...options };
	const proc: Subprocess = registerSubprocess(
		spawn({
			cmd: getAudioExtractArgs(videoUrl, opts),
			stdout: "pipe",
			stderr: "pipe",
		}),
	);

	const operation = registerMediaOperation("audio", () =>
		terminateProcess(proc),
	);
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let cleaned = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (timeoutId) clearTimeout(timeoutId);
		if (reader) {
			try {
				reader.cancel().catch(() => {});
				reader.releaseLock();
			} catch {}
			reader = null;
		}
		unregisterMediaOperation(operation);
		void terminateProcess(proc);
	};

	timeoutId = setTimeout(() => {
		cleanup();
	}, opts.timeoutMs);

	void drainStream(proc.stderr as ReadableStream<Uint8Array>);

	proc.exited.then(() => {
		cleanup();
	});

	const originalStream = proc.stdout as ReadableStream<Uint8Array>;

	const stream = new ReadableStream<Uint8Array>(
		{
			start() {
				reader = originalStream.getReader();
			},
			async pull(controller) {
				if (!reader || cleaned) {
					controller.close();
					return;
				}

				try {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
						cleanup();
					} else {
						controller.enqueue(value);
					}
				} catch (err) {
					controller.error(err);
					cleanup();
				}
			},
			cancel() {
				cleanup();
			},
		},
		new CountQueuingStrategy({ highWaterMark: 4 }),
	);

	return { stream, cleanup };
}
