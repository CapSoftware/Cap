import { type Subprocess, spawn } from "bun";

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

const CHECK_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024;

let activeProcesses = 0;
const MAX_CONCURRENT_PROCESSES = 6;

export function getActiveProcessCount(): number {
	return activeProcesses;
}

export function canAcceptNewProcess(): boolean {
	return activeProcesses < MAX_CONCURRENT_PROCESSES;
}

function killProcess(proc: Subprocess): void {
	try {
		proc.kill();
	} catch {}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	cleanup?: () => void,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			cleanup?.();
			reject(new Error(`Operation timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([promise, timeoutPromise]);
		if (timeoutId) clearTimeout(timeoutId);
		return result;
	} catch (err) {
		if (timeoutId) clearTimeout(timeoutId);
		throw err;
	}
}

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
		while (totalBytes < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalBytes += value.length;
		}
	} finally {
		reader.releaseLock();
	}

	const decoder = new TextDecoder();
	return chunks
		.map((chunk) => decoder.decode(chunk, { stream: true }))
		.join("");
}

const MAX_STDERR_BYTES = 64 * 1024;

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	if (!canAcceptNewProcess()) {
		throw new Error("Server is busy, please try again later");
	}

	activeProcesses++;

	const proc = spawn({
		cmd: ["ffmpeg", "-i", videoUrl, "-hide_banner"],
		stdout: "pipe",
		stderr: "pipe",
	});

	try {
		const result = await withTimeout(
			(async () => {
				drainStream(proc.stdout as ReadableStream<Uint8Array>);

				const stderrText = await readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				);
				await proc.exited;
				return /Stream #\d+:\d+.*Audio:/.test(stderrText);
			})(),
			CHECK_TIMEOUT_MS,
			() => killProcess(proc),
		);

		return result;
	} finally {
		activeProcesses--;
		killProcess(proc);
	}
}

export async function extractAudio(
	videoUrl: string,
	options: AudioExtractionOptions = {},
): Promise<Uint8Array> {
	if (!canAcceptNewProcess()) {
		throw new Error("Server is busy, please try again later");
	}

	activeProcesses++;

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

	try {
		const result = await withTimeout(
			(async () => {
				const stderrPromise = readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				);

				const chunks: Uint8Array[] = [];
				let totalBytes = 0;
				const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();

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

				if (exitCode !== 0) {
					throw new Error(`FFmpeg exited with code ${exitCode}: ${stderrText}`);
				}

				const output = new Uint8Array(totalBytes);
				let offset = 0;
				for (const chunk of chunks) {
					output.set(chunk, offset);
					offset += chunk.length;
				}

				return output;
			})(),
			EXTRACT_TIMEOUT_MS,
			() => killProcess(proc),
		);

		return result;
	} finally {
		activeProcesses--;
		killProcess(proc);
	}
}

export interface StreamingExtractResult {
	stream: ReadableStream<Uint8Array>;
	cleanup: () => void;
}

export function extractAudioStream(
	videoUrl: string,
	options: AudioExtractionOptions = {},
): StreamingExtractResult {
	if (!canAcceptNewProcess()) {
		throw new Error("Server is busy, please try again later");
	}

	activeProcesses++;

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
		activeProcesses--;
		killProcess(proc);
	};

	timeoutId = setTimeout(() => {
		console.error("[ffmpeg] Stream extraction timed out");
		cleanup();
	}, EXTRACT_TIMEOUT_MS);

	drainStream(proc.stderr as ReadableStream<Uint8Array>);

	proc.exited.then((code) => {
		if (code !== 0 && !cleaned) {
			console.error(`[ffmpeg] Stream extraction exited with code ${code}`);
		}
		cleanup();
	});

	const originalStream = proc.stdout as ReadableStream<Uint8Array>;

	const wrappedStream = new ReadableStream<Uint8Array>(
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

	return { stream: wrappedStream, cleanup };
}
