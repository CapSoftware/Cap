import { file, spawn } from "bun";
import type { VideoMetadata } from "./job-manager";
import { registerSubprocess, terminateProcess } from "./subprocess";
import { createTempFile, type TempFileHandle } from "./temp-files";

const PROCESS_TIMEOUT_MS = 45 * 60 * 1000;
const PROCESS_TIMEOUT_PER_SECOND_MS = 20_000;
const MAX_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_UPLOAD_RETRIES = 4;
const INITIAL_UPLOAD_RETRY_DELAY_MS = 250;
const MAX_STDERR_BYTES = 64 * 1024;

export interface VideoProcessingOptions {
	maxWidth?: number;
	maxHeight?: number;
	videoBitrate?: string;
	audioBitrate?: string;
	crf?: number;
	preset?: "ultrafast" | "fast" | "medium" | "slow";
	remuxOnly?: boolean;
	timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<VideoProcessingOptions> = {
	maxWidth: 1920,
	maxHeight: 1080,
	videoBitrate: "5M",
	audioBitrate: "128k",
	crf: 23,
	preset: "medium",
	remuxOnly: false,
	timeoutMs: PROCESS_TIMEOUT_MS,
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

export function normalizeVideoInputExtension(
	inputExtension: string | undefined,
): `.${string}` {
	if (!inputExtension) {
		return ".mp4";
	}

	const normalized = inputExtension.trim().toLowerCase();
	if (!normalized) {
		return ".mp4";
	}

	return normalized.startsWith(".")
		? (normalized as `.${string}`)
		: (`.${normalized}` as `.${string}`);
}

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	cleanup?: () => void | Promise<void>,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			cleanupPromise = (async () => {
				await cleanup?.();
			})().catch(() => undefined);
			reject(new Error(`Operation timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([promise, timeoutPromise]);
		if (timeoutId) clearTimeout(timeoutId);
		return result;
	} catch (err) {
		if (cleanupPromise) {
			await cleanupPromise;
		}
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

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	inputExtension?: string,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const tempFile = await createTempFile(
		normalizeVideoInputExtension(inputExtension),
	);

	console.log(
		`[downloadVideoToTemp] Downloading from URL: ${videoUrl.substring(0, 100)}...`,
	);

	try {
		const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const combinedSignal = abortSignal
			? AbortSignal.any([abortSignal, timeoutSignal])
			: timeoutSignal;

		const response = await fetch(videoUrl, {
			signal: combinedSignal,
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

		const reader = response.body.getReader();
		const writer = file(tempFile.path).writer();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				writer.write(value);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}

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

const REPAIR_TIMEOUT_MS = 5 * 60 * 1000;

export async function repairContainer(
	inputPath: string,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const repairedFile = await createTempFile(".mkv");

	const ffmpegArgs = [
		"ffmpeg",
		"-threads",
		"2",
		"-err_detect",
		"ignore_err",
		"-fflags",
		"+genpts+igndts",
		"-i",
		inputPath,
		"-c",
		"copy",
		"-y",
		repairedFile.path,
	];

	console.log(`[repairContainer] Running: ${ffmpegArgs.join(" ")}`);

	const proc = registerSubprocess(
		spawn({
			cmd: ffmpegArgs,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);

	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			void terminateProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	try {
		await withTimeout(
			(async () => {
				drainStream(proc.stdout as ReadableStream<Uint8Array>);

				const stderrText = await readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				);

				const exitCode = await proc.exited;

				if (exitCode !== 0) {
					console.error(`[repairContainer] FFmpeg stderr:\n${stderrText}`);
					throw new Error(`Container repair failed with exit code ${exitCode}`);
				}

				const outputFile = file(repairedFile.path);
				if (outputFile.size === 0) {
					throw new Error("Container repair produced empty file");
				}

				console.log(
					`[repairContainer] Repair successful: ${outputFile.size} bytes`,
				);
			})(),
			REPAIR_TIMEOUT_MS,
			() => terminateProcess(proc),
		);

		return repairedFile;
	} catch (err) {
		await repairedFile.cleanup();
		throw err;
	} finally {
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		await terminateProcess(proc);
	}
}

export interface ResilientInputFlags {
	errDetectIgnoreErr?: boolean;
	genPts?: boolean;
	discardCorrupt?: boolean;
	maxMuxingQueueSize?: number;
}

function buildExtraInputFlags(flags: ResilientInputFlags): string[] {
	const args: string[] = [];

	if (flags.errDetectIgnoreErr) {
		args.push("-err_detect", "ignore_err");
	}

	const fflags: string[] = [];
	if (flags.genPts) fflags.push("+genpts");
	if (flags.discardCorrupt) fflags.push("+discardcorrupt");
	if (fflags.length > 0) {
		args.push("-fflags", fflags.join(""));
	}

	return args;
}

function buildExtraOutputFlags(flags: ResilientInputFlags): string[] {
	if (flags.maxMuxingQueueSize) {
		return ["-max_muxing_queue_size", flags.maxMuxingQueueSize.toString()];
	}
	return [];
}

function getProcessTimeoutMs(
	durationSeconds: number,
	baseTimeoutMs: number,
): number {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		return baseTimeoutMs;
	}

	return Math.min(
		MAX_PROCESS_TIMEOUT_MS,
		Math.max(
			baseTimeoutMs,
			Math.ceil(durationSeconds * PROCESS_TIMEOUT_PER_SECOND_MS),
		),
	);
}

function isRetryableUploadStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 425 ||
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	);
}

function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function uploadWithRetry(
	presignedUrl: string,
	contentType: string,
	contentLength: number,
	bodyFactory: () => Blob | Uint8Array | ArrayBuffer | BunFile,
): Promise<void> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
		try {
			const response = await fetch(presignedUrl, {
				method: "PUT",
				headers: {
					"Content-Type": contentType,
					"Content-Length": contentLength.toString(),
				},
				body: bodyFactory(),
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});

			if (response.ok) {
				return;
			}

			const responseError = new Error(
				`S3 upload failed: ${response.status} ${response.statusText}`,
			);

			if (
				!isRetryableUploadStatus(response.status) ||
				attempt === MAX_UPLOAD_RETRIES
			) {
				throw responseError;
			}

			lastError = responseError;
			const delay = INITIAL_UPLOAD_RETRY_DELAY_MS * 2 ** attempt;
			console.warn(
				`[uploadWithRetry] Retrying upload after ${response.status} in ${delay}ms (attempt ${attempt + 1}/${MAX_UPLOAD_RETRIES})`,
			);
			await sleep(delay);
		} catch (err) {
			const uploadError = err instanceof Error ? err : new Error(String(err));

			if (attempt === MAX_UPLOAD_RETRIES) {
				throw uploadError;
			}

			lastError = uploadError;
			const delay = INITIAL_UPLOAD_RETRY_DELAY_MS * 2 ** attempt;
			console.warn(
				`[uploadWithRetry] Upload attempt failed: ${getErrorMessage(uploadError)}; retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_UPLOAD_RETRIES})`,
			);
			await sleep(delay);
		}
	}

	throw lastError ?? new Error("S3 upload failed after retries");
}

export async function processVideo(
	inputPath: string,
	metadata: VideoMetadata,
	options: VideoProcessingOptions = {},
	onProgress?: ProgressCallback,
	abortSignal?: AbortSignal,
	resilientFlags?: ResilientInputFlags,
): Promise<TempFileHandle> {
	const definedOptions = Object.fromEntries(
		Object.entries(options).filter(([, v]) => v !== undefined),
	) as VideoProcessingOptions;
	const opts = { ...DEFAULT_OPTIONS, ...definedOptions };
	const outputTempFile = await createTempFile(".mp4");

	const remuxOnly = opts.remuxOnly;
	const videoTranscode = remuxOnly
		? false
		: needsVideoTranscode(metadata, opts);
	const audioTranscode = remuxOnly ? false : needsAudioTranscode(metadata);

	const extraInputArgs = resilientFlags
		? buildExtraInputFlags(resilientFlags)
		: [];
	const extraOutputArgs = resilientFlags
		? buildExtraOutputFlags(resilientFlags)
		: [];
	const processTimeoutMs = getProcessTimeoutMs(
		metadata.duration,
		opts.timeoutMs,
	);

	const ffmpegArgs: string[] = [
		"ffmpeg",
		"-threads",
		"2",
		...extraInputArgs,
		"-i",
		inputPath,
	];

	if (videoTranscode) {
		ffmpegArgs.push(
			"-c:v",
			"libx264",
			"-preset",
			opts.preset,
			"-crf",
			opts.crf.toString(),
			"-vf",
			`scale='min(${opts.maxWidth},iw)':'min(${opts.maxHeight},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
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
		...extraOutputArgs,
		"-progress",
		"pipe:2",
		"-y",
		outputTempFile.path,
	);

	console.log(`[processVideo] Running FFmpeg: ${ffmpegArgs.join(" ")}`);

	const proc = registerSubprocess(
		spawn({
			cmd: ffmpegArgs,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);

	const totalDurationUs = metadata.duration * 1_000_000;

	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			void terminateProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	const stderrLines: string[] = [];
	const MAX_STDERR_LINES = 50;

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
							stderrLines.push(line);
							if (stderrLines.length > MAX_STDERR_LINES) {
								stderrLines.shift();
							}
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
					const stderrOutput = stderrLines.join("\n");
					console.error(`[processVideo] FFmpeg stderr:\n${stderrOutput}`);
					throw new Error(
						`FFmpeg exited with code ${exitCode}. Last stderr: ${stderrLines.slice(-10).join(" | ")}`,
					);
				}

				const outputFile = file(outputTempFile.path);
				const outputSize = await outputFile.size;
				if (outputSize === 0) {
					throw new Error("FFmpeg produced empty output file");
				}
			})(),
			processTimeoutMs,
			() => terminateProcess(proc),
		);

		return outputTempFile;
	} catch (err) {
		await outputTempFile.cleanup();
		throw err;
	} finally {
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		await terminateProcess(proc);
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

	const proc = registerSubprocess(
		spawn({
			cmd: ffmpegArgs,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);

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
			() => terminateProcess(proc),
		);

		return result;
	} finally {
		await terminateProcess(proc);
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

	await uploadWithRetry(presignedUrl, contentType, blob.size, () => blob);
}

export async function uploadFileToS3(
	filePath: string,
	presignedUrl: string,
	contentType: string,
): Promise<void> {
	const fileHandle = file(filePath);

	await uploadWithRetry(presignedUrl, contentType, fileHandle.size, () =>
		file(filePath),
	);
}
