import { type Subprocess, spawn } from "bun";
import { createMediaInput, withTimeout } from "./media-common";
import {
	canAcceptNewAudioOperation,
	getActiveAudioOperationCount,
	registerMediaOperation,
	unregisterMediaOperation,
	withMediaOperation,
} from "./media-operations";
import { checkVideoAccessible } from "./media-probe";
import { registerSubprocess, terminateProcess } from "./subprocess";

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
	return output.split(url).join(redactUrl(url));
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

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	if (!canAcceptNewAudioOperation()) {
		throw new Error("Server is busy, please try again later");
	}

	return await withMediaOperation("audio", () =>
		withTimeout(
			(async () => {
				const input = createMediaInput(videoUrl);
				try {
					const videoTrack = await input.getPrimaryVideoTrack();
					if (!videoTrack) {
						if (!(await checkVideoAccessible(videoUrl))) {
							throw new Error(
								"Media engine could not read video file: no streams detected",
							);
						}
						throw new Error("No video stream found");
					}
					const audioTrack = await input.getPrimaryAudioTrack();
					return Boolean(audioTrack);
				} finally {
					input.dispose();
				}
			})(),
			CHECK_TIMEOUT_MS,
		),
	);
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
