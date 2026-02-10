import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { file, type Subprocess, spawn } from "bun";
import type { VideoMetadata } from "./job-manager";
import { createTempFile, type TempFileHandle } from "./temp-files";

const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 60_000;
const PREVIEW_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_BYTES = 64 * 1024;
const PROGRESS_STALL_TIMEOUT_MS = 180_000;
const PROGRESS_STALL_NEAR_COMPLETE_TIMEOUT_MS = 60_000;
const DOCKER_HOSTNAME = "host.docker.internal";
const RUNNING_IN_DOCKER = existsSync("/.dockerenv");

interface BridgedUrl {
	url: string;
	hostHeader?: string;
}

export interface VideoProcessingOptions {
	maxWidth?: number;
	maxHeight?: number;
	videoBitrate?: string;
	audioBitrate?: string;
	crf?: number;
	preset?: "ultrafast" | "fast" | "medium" | "slow";
	remuxOnly?: boolean;
}

export interface TimelineSegment {
	start: number;
	end: number;
	timescale: number;
}

const WEB_PUBLIC_DIR = resolve(import.meta.dir, "../../../web/public");

const DEFAULT_OPTIONS: Required<VideoProcessingOptions> = {
	maxWidth: 1920,
	maxHeight: 1080,
	videoBitrate: "5M",
	audioBitrate: "128k",
	crf: 23,
	preset: "medium",
	remuxOnly: false,
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

export interface PreviewVideoOptions {
	start?: number;
	duration?: number;
	maxWidth?: number;
	maxHeight?: number;
	fps?: number;
	crf?: number;
	preset?: "ultrafast" | "fast" | "medium" | "slow";
}

const DEFAULT_PREVIEW_VIDEO_OPTIONS: Required<PreviewVideoOptions> = {
	start: -1,
	duration: 3,
	maxWidth: 480,
	maxHeight: 480,
	fps: 12,
	crf: 32,
	preset: "fast",
};

function killProcess(proc: Subprocess): void {
	try {
		proc.kill();
	} catch {}
}

function createProgressWatchdog(proc: Subprocess): {
	touch: (timeoutMs?: number) => void;
	clear: () => void;
	isStalled: () => boolean;
} {
	let stalled = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const schedule = (timeoutMs: number) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}

		timeoutId = setTimeout(() => {
			stalled = true;
			killProcess(proc);
		}, timeoutMs);
	};

	schedule(PROGRESS_STALL_TIMEOUT_MS);

	return {
		touch: (timeoutMs = PROGRESS_STALL_TIMEOUT_MS) => {
			if (!stalled) {
				schedule(timeoutMs);
			}
		},
		clear: () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = undefined;
			}
		},
		isStalled: () => stalled,
	};
}

function bridgeLoopbackUrl(url: string): BridgedUrl {
	if (!RUNNING_IN_DOCKER) {
		return { url };
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { url };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { url };
	}

	if (
		parsed.hostname !== "localhost" &&
		parsed.hostname !== "127.0.0.1" &&
		parsed.hostname !== "::1"
	) {
		return { url };
	}

	const hostHeader = parsed.host;
	parsed.hostname = DOCKER_HOSTNAME;
	return {
		url: parsed.toString(),
		hostHeader,
	};
}

function withHostHeader(
	headers: HeadersInit | undefined,
	hostHeader: string | undefined,
): Headers {
	const resolved = new Headers(headers);
	if (hostHeader) {
		resolved.set("Host", hostHeader);
	}
	return resolved;
}

export async function fetchWithLoopbackBridge(
	url: string,
	init: RequestInit,
): Promise<Response> {
	const bridged = bridgeLoopbackUrl(url);

	return fetch(bridged.url, {
		...init,
		headers: withHostHeader(init.headers, bridged.hostHeader),
	});
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

export function resolveBackgroundImagePath(path: string): string | null {
	const trimmed = path.trim();
	if (trimmed.length === 0) return null;

	if (
		trimmed.startsWith("http://") ||
		trimmed.startsWith("https://") ||
		trimmed.startsWith("file://")
	) {
		return bridgeLoopbackUrl(trimmed).url;
	}

	if (trimmed.startsWith("/backgrounds/")) {
		const localPath = join(WEB_PUBLIC_DIR, trimmed.slice(1));
		if (existsSync(localPath)) {
			return localPath;
		}
		return trimmed;
	}

	if (trimmed.startsWith("backgrounds/")) {
		const localPath = join(WEB_PUBLIC_DIR, trimmed);
		if (existsSync(localPath)) {
			return localPath;
		}
		return trimmed;
	}

	if (trimmed.startsWith("/")) {
		if (existsSync(trimmed)) {
			return trimmed;
		}

		const localPath = join(WEB_PUBLIC_DIR, trimmed.slice(1));
		if (existsSync(localPath)) {
			return localPath;
		}
		return trimmed;
	}

	if (existsSync(trimmed)) {
		return resolve(trimmed);
	}

	const localPath = join(WEB_PUBLIC_DIR, "backgrounds", trimmed);
	if (existsSync(localPath)) {
		return localPath;
	}

	return trimmed;
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

export function formatFfmpegNumber(value: number): string {
	return Number(value.toFixed(6)).toString();
}

export function normalizeTimelineSegments(
	segments: ReadonlyArray<TimelineSegment>,
	duration: number,
): TimelineSegment[] {
	const normalized = segments
		.map((segment) => {
			const start = Math.max(0, Math.min(duration, segment.start));
			const end = Math.max(0, Math.min(duration, segment.end));
			const timescale =
				Number.isFinite(segment.timescale) && segment.timescale > 0
					? segment.timescale
					: 1;
			return {
				start: Math.min(start, end),
				end: Math.max(start, end),
				timescale,
			};
		})
		.filter((segment) => segment.end - segment.start >= 0.01)
		.sort((a, b) => a.start - b.start);

	if (normalized.length > 0) {
		return normalized;
	}

	return [
		{
			start: 0,
			end: Math.max(duration, 0.1),
			timescale: 1,
		},
	];
}

export function buildAtempoFilter(timescale: number): string {
	let remaining = timescale;
	const filters: string[] = [];

	while (remaining > 2) {
		filters.push("atempo=2");
		remaining /= 2;
	}

	while (remaining < 0.5) {
		filters.push("atempo=0.5");
		remaining *= 2;
	}

	if (Math.abs(remaining - 1) > 0.000001) {
		filters.push(`atempo=${formatFfmpegNumber(remaining)}`);
	}

	return filters.join(",");
}

export function buildVideoTimelineFilterGraph(
	segments: ReadonlyArray<TimelineSegment>,
): {
	filterGraph: string;
	totalDuration: number;
} {
	const filters: string[] = [];
	const concatInputs: string[] = [];
	let totalDuration = 0;

	for (const [index, segment] of segments.entries()) {
		const segmentDuration = (segment.end - segment.start) / segment.timescale;
		totalDuration += segmentDuration;

		filters.push(
			`[0:v]trim=start=${formatFfmpegNumber(segment.start)}:end=${formatFfmpegNumber(segment.end)},setpts=(PTS-STARTPTS)/${formatFfmpegNumber(segment.timescale)}[v${index}]`,
		);
		concatInputs.push(`[v${index}]`);
	}

	filters.push(
		`${concatInputs.join("")}concat=n=${segments.length}:v=1:a=0[vout]`,
	);

	return {
		filterGraph: filters.join(";"),
		totalDuration,
	};
}

export function buildAudioTimelineFilterGraph(
	segments: ReadonlyArray<TimelineSegment>,
	inputIndex = 0,
): string {
	const filters: string[] = [];
	const concatInputs: string[] = [];

	for (const [index, segment] of segments.entries()) {
		const atempo = buildAtempoFilter(segment.timescale);
		const audioFilters = atempo.length > 0 ? `,${atempo}` : "";
		filters.push(
			`[${inputIndex}:a]atrim=start=${formatFfmpegNumber(segment.start)}:end=${formatFfmpegNumber(segment.end)},asetpts=PTS-STARTPTS${audioFilters}[a${index}]`,
		);
		concatInputs.push(`[a${index}]`);
	}

	filters.push(
		`${concatInputs.join("")}concat=n=${segments.length}:v=0:a=1[aout]`,
	);

	return filters.join(";");
}

export async function downloadVideoToTemp(
	videoUrl: string,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const tempFile = await createTempFile(".mp4");
	const bridgedVideoUrl = bridgeLoopbackUrl(videoUrl);

	console.log(
		`[downloadVideoToTemp] Downloading from URL: ${bridgedVideoUrl.url.substring(0, 100)}...`,
	);

	try {
		const response = await fetchWithLoopbackBridge(videoUrl, {
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

	const ffmpegArgs: string[] = ["ffmpeg", "-threads", "2", "-i", inputPath];

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
		"-progress",
		"pipe:2",
		"-y",
		outputTempFile.path,
	);

	console.log(`[processVideo] Running FFmpeg: ${ffmpegArgs.join(" ")}`);

	const proc = spawn({
		cmd: ffmpegArgs,
		stdout: "pipe",
		stderr: "pipe",
	});
	const progressWatchdog = createProgressWatchdog(proc);
	let watchdogTimeoutMs = PROGRESS_STALL_TIMEOUT_MS;
	let reachedNearCompleteProgress = false;

	const totalDurationUs = metadata.duration * 1_000_000;

	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			killProcess(proc);
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
							if (progress !== null && progress >= 98) {
								reachedNearCompleteProgress = true;
							}
							const timeoutMs = reachedNearCompleteProgress
								? PROGRESS_STALL_NEAR_COMPLETE_TIMEOUT_MS
								: PROGRESS_STALL_TIMEOUT_MS;
							watchdogTimeoutMs = timeoutMs;
							progressWatchdog.touch(timeoutMs);
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
					if (progressWatchdog.isStalled()) {
						throw new Error(
							`FFmpeg progress stalled for ${watchdogTimeoutMs}ms`,
						);
					}
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
			PROCESS_TIMEOUT_MS,
			() => killProcess(proc),
		);

		return outputTempFile;
	} catch (err) {
		await outputTempFile.cleanup();
		throw err;
	} finally {
		progressWatchdog.clear();
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

export async function generatePreviewVideo(
	inputPath: string,
	sourceDuration: number,
	options: PreviewVideoOptions = {},
): Promise<TempFileHandle> {
	const opts = { ...DEFAULT_PREVIEW_VIDEO_OPTIONS, ...options };
	const outputTempFile = await createTempFile(".mp4");

	const clipDuration = Math.max(0.2, opts.duration);
	let start = opts.start;

	if (start === undefined || start < 0) {
		start = Math.min(1, Math.max(0, sourceDuration - clipDuration - 0.1));
	}

	start = Math.min(Math.max(0, start), Math.max(0, sourceDuration - 0.1));

	const fps = Math.max(1, Math.min(60, Math.round(opts.fps)));
	const maxWidth = Math.max(64, Math.min(1920, Math.round(opts.maxWidth)));
	const maxHeight = Math.max(64, Math.min(1920, Math.round(opts.maxHeight)));
	const crf = Math.max(0, Math.min(51, Math.round(opts.crf)));

	const vf = `fps=${fps},scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;

	const ffmpegArgs = [
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-threads",
		"2",
		"-ss",
		start.toString(),
		"-i",
		inputPath,
		"-t",
		clipDuration.toString(),
		"-an",
		"-c:v",
		"libx264",
		"-preset",
		opts.preset,
		"-crf",
		crf.toString(),
		"-vf",
		vf,
		"-pix_fmt",
		"yuv420p",
		"-profile:v",
		"baseline",
		"-level",
		"3.0",
		"-movflags",
		"+faststart",
		"-y",
		outputTempFile.path,
	];

	const proc = spawn({
		cmd: ffmpegArgs,
		stdout: "pipe",
		stderr: "pipe",
	});

	try {
		await withTimeout(
			(async () => {
				drainStream(proc.stdout as ReadableStream<Uint8Array>);

				const stderrOutput = await readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				);
				const exitCode = await proc.exited;

				if (exitCode !== 0) {
					throw new Error(
						`FFmpeg preview exited with code ${exitCode}. Stderr: ${stderrOutput}`,
					);
				}

				const outputFile = file(outputTempFile.path);
				const outputSize = await outputFile.size;
				if (outputSize === 0) {
					throw new Error("FFmpeg produced empty preview file");
				}
			})(),
			PREVIEW_TIMEOUT_MS,
			() => killProcess(proc),
		);

		return outputTempFile;
	} catch (err) {
		await outputTempFile.cleanup();
		throw err;
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
	const response = await fetchWithLoopbackBridge(presignedUrl, {
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
	const arrayBuffer = await fileHandle.arrayBuffer();

	const response = await fetchWithLoopbackBridge(presignedUrl, {
		method: "PUT",
		headers: {
			"Content-Type": contentType,
			"Content-Length": arrayBuffer.byteLength.toString(),
		},
		body: arrayBuffer,
	});

	if (!response.ok) {
		throw new Error(
			`Failed to upload file to S3: ${response.status} ${response.statusText}`,
		);
	}
}
