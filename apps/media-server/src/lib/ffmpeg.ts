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
				const stderrText = await new Response(proc.stderr).text();
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
				const [stdout, stderrText, exitCode] = await Promise.all([
					new Response(proc.stdout).arrayBuffer(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);

				if (exitCode !== 0) {
					throw new Error(`FFmpeg exited with code ${exitCode}: ${stderrText}`);
				}

				if (stdout.byteLength > MAX_AUDIO_SIZE_BYTES) {
					throw new Error(
						`Audio too large: ${stdout.byteLength} bytes exceeds ${MAX_AUDIO_SIZE_BYTES} byte limit`,
					);
				}

				return new Uint8Array(stdout);
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

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (timeoutId) clearTimeout(timeoutId);
		activeProcesses--;
		killProcess(proc);
	};

	timeoutId = setTimeout(() => {
		console.error("[ffmpeg] Stream extraction timed out");
		cleanup();
	}, EXTRACT_TIMEOUT_MS);

	proc.exited.then((code) => {
		if (code !== 0) {
			console.error(`[ffmpeg] Stream extraction exited with code ${code}`);
		}
		cleanup();
	});

	const originalStream = proc.stdout as ReadableStream<Uint8Array>;

	const wrappedStream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = originalStream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					controller.enqueue(value);
				}
				controller.close();
			} catch (err) {
				controller.error(err);
			} finally {
				reader.releaseLock();
				cleanup();
			}
		},
		cancel() {
			cleanup();
		},
	});

	return { stream: wrappedStream, cleanup };
}
