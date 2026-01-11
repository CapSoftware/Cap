import { file, type Subprocess, spawn } from "bun";
import type { VideoMetadata } from "./job-manager";
import { createTempFile, type TempFileHandle } from "./temp-files";

const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_BYTES = 64 * 1024;

export interface VideoProcessingOptions {
	maxWidth?: number;
	maxHeight?: number;
	videoBitrate?: string;
	audioBitrate?: string;
	crf?: number;
	preset?: "ultrafast" | "fast" | "medium" | "slow";
}

const DEFAULT_OPTIONS: Required<VideoProcessingOptions> = {
	maxWidth: 1920,
	maxHeight: 1080,
	videoBitrate: "5M",
	audioBitrate: "128k",
	crf: 23,
	preset: "medium",
};

export interface ThumbnailOptions {
	timestamp?: number;
	width?: number;
	height?: number;
	quality?: number;
}

const DEFAULT_THUMBNAIL_OPTIONS: Required<ThumbnailOptions> = {
	timestamp: 1,
	width: 1280,
	height: 720,
	quality: 85,
};

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

export type ProgressCallback = (progress: number, message: string) => void;

function parseProgressFromStderr(
	stderrLine: string,
	totalDurationUs: number,
): number | null {
	const match = stderrLine.match(/out_time_us=(\d+)/);
	if (!match) return null;
	const currentUs = Number.parseInt(match[1] ?? "0", 10);
	return Math.min(100, (currentUs / totalDurationUs) * 100);
}

function needsVideoTranscode(
	metadata: VideoMetadata,
	options: VideoProcessingOptions,
): boolean {
	const maxWidth = options.maxWidth ?? DEFAULT_OPTIONS.maxWidth;
	const maxHeight = options.maxHeight ?? DEFAULT_OPTIONS.maxHeight;

	const needsResize = metadata.width > maxWidth || metadata.height > maxHeight;
	const needsCodecChange = metadata.videoCodec !== "h264";

	return needsResize || needsCodecChange;
}

function needsAudioTranscode(metadata: VideoMetadata): boolean {
	if (!metadata.audioCodec) return false;
	return metadata.audioCodec !== "aac";
}

export async function downloadVideoToTemp(
	videoUrl: string,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const tempFile = await createTempFile(".mp4");

	console.log(
		`[downloadVideoToTemp] Downloading from URL: ${videoUrl.substring(0, 100)}...`,
	);

	try {
		const response = await fetch(videoUrl, {
			signal: abortSignal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});

		console.log(
			`[downloadVideoToTemp] Response status: ${response.status}, content-type: ${response.headers.get("content-type")}, content-length: ${response.headers.get("content-length")}`,
		);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			console.error(
				`[downloadVideoToTemp] Error response body: ${errorBody.substring(0, 500)}`,
			);
			throw new Error(
				`Failed to download video: ${response.status} ${response.statusText}`,
			);
		}

		if (!response.body) {
			throw new Error("No response body");
		}

		const arrayBuffer = await response.arrayBuffer();
		await Bun.write(tempFile.path, arrayBuffer);

		const fileHandle = file(tempFile.path);
		const fileSize = fileHandle.size;
		console.log(
			`[downloadVideoToTemp] Downloaded file size: ${fileSize} bytes to ${tempFile.path}`,
		);

		if (fileSize < 1000) {
			const content = await fileHandle.text();
			console.error(
				`[downloadVideoToTemp] Small file content: ${content.substring(0, 500)}`,
			);
		}

		return tempFile;
	} catch (err) {
		console.error(`[downloadVideoToTemp] Download failed:`, err);
		await tempFile.cleanup();
		throw err;
	}
}

export async function processVideo(
	inputPath: string,
	metadata: VideoMetadata,
	options: VideoProcessingOptions = {},
	onProgress?: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const outputTempFile = await createTempFile(".mp4");

	const videoTranscode = needsVideoTranscode(metadata, opts);
	const audioTranscode = needsAudioTranscode(metadata);

	const ffmpegArgs: string[] = ["ffmpeg", "-i", inputPath];

	if (videoTranscode) {
		ffmpegArgs.push(
			"-c:v",
			"libx264",
			"-preset",
			opts.preset,
			"-crf",
			opts.crf.toString(),
			"-vf",
			`scale='min(${opts.maxWidth},iw)':'min(${opts.maxHeight},ih)':force_original_aspect_ratio=decrease`,
		);
	} else {
		ffmpegArgs.push("-c:v", "copy");
	}

	if (metadata.audioCodec) {
		if (audioTranscode) {
			ffmpegArgs.push("-c:a", "aac", "-b:a", opts.audioBitrate);
		} else {
			ffmpegArgs.push("-c:a", "copy");
		}
	} else {
		ffmpegArgs.push("-an");
	}

	ffmpegArgs.push(
		"-movflags",
		"+faststart",
		"-progress",
		"pipe:2",
		"-y",
		outputTempFile.path,
	);

	const proc = spawn({
		cmd: ffmpegArgs,
		stdout: "pipe",
		stderr: "pipe",
	});

	const totalDurationUs = metadata.duration * 1_000_000;

	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			killProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	try {
		await withTimeout(
			(async () => {
				drainStream(proc.stdout as ReadableStream<Uint8Array>);

				const stderrReader = (
					proc.stderr as ReadableStream<Uint8Array>
				).getReader();
				const decoder = new TextDecoder();
				let stderrBuffer = "";

				try {
					while (true) {
						const { done, value } = await stderrReader.read();
						if (done) break;

						stderrBuffer += decoder.decode(value, { stream: true });

						const lines = stderrBuffer.split("\n");
						stderrBuffer = lines.pop() ?? "";

						for (const line of lines) {
							const progress = parseProgressFromStderr(line, totalDurationUs);
							if (progress !== null && onProgress) {
								onProgress(progress, `Encoding: ${Math.round(progress)}%`);
							}
						}
					}
				} finally {
					stderrReader.releaseLock();
				}

				const exitCode = await proc.exited;

				if (exitCode !== 0) {
					throw new Error(`FFmpeg exited with code ${exitCode}`);
				}

				const outputFile = file(outputTempFile.path);
				const outputSize = await outputFile.size;
				if (outputSize === 0) {
					throw new Error("FFmpeg produced empty output file");
				}
			})(),
			PROCESS_TIMEOUT_MS,
			() => killProcess(proc),
		);

		return outputTempFile;
	} catch (err) {
		await outputTempFile.cleanup();
		throw err;
	} finally {
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		killProcess(proc);
	}
}

export async function generateThumbnail(
	inputPath: string,
	duration: number,
	options: ThumbnailOptions = {},
): Promise<Uint8Array> {
	const opts = { ...DEFAULT_THUMBNAIL_OPTIONS, ...options };

	let timestamp = opts.timestamp;
	if (timestamp === undefined || timestamp <= 0) {
		timestamp = Math.min(duration / 4, 1);
	}
	timestamp = Math.min(timestamp, duration - 0.1);

	const qualityValue = Math.max(
		2,
		Math.min(31, Math.round(31 - (opts.quality / 100) * 29)),
	);

	const ffmpegArgs = [
		"ffmpeg",
		"-ss",
		timestamp.toString(),
		"-i",
		inputPath,
		"-vframes",
		"1",
		"-vf",
		`scale='min(${opts.width},iw)':'min(${opts.height},ih)':force_original_aspect_ratio=decrease`,
		"-q:v",
		qualityValue.toString(),
		"-f",
		"image2",
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
						chunks.push(value);
						totalBytes += value.length;
					}
				} finally {
					reader.releaseLock();
				}

				const [, exitCode] = await Promise.all([stderrPromise, proc.exited]);

				if (exitCode !== 0) {
					throw new Error(`FFmpeg thumbnail exited with code ${exitCode}`);
				}

				if (totalBytes === 0) {
					throw new Error("FFmpeg produced empty thumbnail");
				}

				const output = new Uint8Array(totalBytes);
				let offset = 0;
				for (const chunk of chunks) {
					output.set(chunk, offset);
					offset += chunk.length;
				}

				return output;
			})(),
			THUMBNAIL_TIMEOUT_MS,
			() => killProcess(proc),
		);

		return result;
	} finally {
		killProcess(proc);
	}
}

export async function uploadToS3(
	data: Uint8Array | Blob,
	presignedUrl: string,
	contentType: string,
): Promise<void> {
	const blob =
		data instanceof Blob
			? data
			: new Blob([data.buffer as ArrayBuffer], { type: contentType });
	const response = await fetch(presignedUrl, {
		method: "PUT",
		headers: {
			"Content-Type": contentType,
			"Content-Length": blob.size.toString(),
		},
		body: blob,
	});

	if (!response.ok) {
		throw new Error(
			`Failed to upload to S3: ${response.status} ${response.statusText}`,
		);
	}
}

export async function uploadFileToS3(
	filePath: string,
	presignedUrl: string,
	contentType: string,
): Promise<void> {
	const fileHandle = file(filePath);
	const stream = fileHandle.stream();

	const response = await fetch(presignedUrl, {
		method: "PUT",
		headers: {
			"Content-Type": contentType,
			"Content-Length": fileHandle.size.toString(),
		},
		body: stream,
		duplex: "half",
	} as RequestInit);

	if (!response.ok) {
		throw new Error(
			`Failed to upload file to S3: ${response.status} ${response.statusText}`,
		);
	}
}
