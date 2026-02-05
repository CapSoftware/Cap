import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RgbTuple } from "@cap/editor-render-spec";
import {
	computeRenderSpec,
	normalizeConfigForRender,
} from "@cap/editor-render-spec";
import { file, type Subprocess, spawn } from "bun";
import type { VideoMetadata } from "./job-manager";
import { createTempFile, type TempFileHandle } from "./temp-files";

const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 60_000;
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

interface EditorRenderLayout {
	outputWidth: number;
	outputHeight: number;
	innerWidth: number;
	innerHeight: number;
	borderRadius: number;
	shadow: {
		enabled: boolean;
		offsetY: number;
		blur: number;
		spread: number;
		opacity: number;
	};
	backgroundImagePath: string | null;
	backgroundGradient: {
		from: RgbTuple;
		to: RgbTuple;
		angle: number;
	} | null;
	backgroundColor: string;
	backgroundColorAlpha: number;
	shouldApply: boolean;
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

export function useCanvasRenderer(): boolean {
	return process.env.CAP_CANVAS_RENDERER !== "false";
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

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function normalizeChannel(value: number): number {
	return Math.round(clamp(value, 0, 255));
}

function toHexColor([r, g, b]: RgbTuple): string {
	const channels = [
		normalizeChannel(r),
		normalizeChannel(g),
		normalizeChannel(b),
	];
	const hex = channels
		.map((channel) => channel.toString(16).padStart(2, "0"))
		.join("");
	return `0x${hex}`;
}

function buildLinearGradientGeq(options: {
	from: RgbTuple;
	to: RgbTuple;
	angle: number;
	width: number;
	height: number;
}): { r: string; g: string; b: string } {
	const theta = (options.angle * Math.PI) / 180;
	const dx = Math.sin(theta);
	const dy = -Math.cos(theta);
	const halfW = (options.width - 1) / 2;
	const halfH = (options.height - 1) / 2;

	const projections = [
		[-halfW, -halfH],
		[halfW, -halfH],
		[-halfW, halfH],
		[halfW, halfH],
	].map(([x, y]) => x * dx + y * dy);

	const min = Math.min(...projections);
	const max = Math.max(...projections);
	const denom = Math.abs(max - min) > 1e-9 ? max - min : 1;

	const dxExpr = formatFfmpegNumber(dx);
	const dyExpr = formatFfmpegNumber(dy);
	const halfWExpr = formatFfmpegNumber(halfW);
	const halfHExpr = formatFfmpegNumber(halfH);
	const minExpr = formatFfmpegNumber(min);
	const denomExpr = formatFfmpegNumber(denom);

	const t = `max(0,min(1,(((X-${halfWExpr})*${dxExpr})+((Y-${halfHExpr})*${dyExpr})-${minExpr})/${denomExpr}))`;

	const [fromR, fromG, fromB] = options.from;
	const [toR, toG, toB] = options.to;

	return {
		r: `${normalizeChannel(fromR)}+(${normalizeChannel(toR)}-${normalizeChannel(fromR)})*${t}`,
		g: `${normalizeChannel(fromG)}+(${normalizeChannel(toG)}-${normalizeChannel(fromG)})*${t}`,
		b: `${normalizeChannel(fromB)}+(${normalizeChannel(toB)}-${normalizeChannel(fromB)})*${t}`,
	};
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

export function getEditorRenderLayout(
	metadata: VideoMetadata,
	projectConfig: unknown,
): EditorRenderLayout {
	const normalized = normalizeConfigForRender(projectConfig);
	const spec = computeRenderSpec(
		normalized.config,
		metadata.width,
		metadata.height,
	);

	let backgroundColor = "0xffffff";
	let backgroundColorAlpha = 1;
	let backgroundGradient: EditorRenderLayout["backgroundGradient"] = null;
	let backgroundImagePath: string | null = null;

	const background = spec.backgroundSpec;
	if (background.type === "color") {
		backgroundColor = toHexColor(background.value);
		backgroundColorAlpha = background.alpha;
	} else if (background.type === "gradient") {
		backgroundColor = toHexColor(background.from);
		backgroundGradient = {
			from: background.from,
			to: background.to,
			angle: background.angle,
		};
	} else if (background.path) {
		backgroundImagePath = resolveBackgroundImagePath(background.path);
	}

	const shadow = spec.shadowSpec;
	const shouldApply =
		spec.outputWidth !== metadata.width ||
		spec.outputHeight !== metadata.height ||
		spec.innerRect.width !== spec.outputWidth ||
		spec.innerRect.height !== spec.outputHeight ||
		spec.maskSpec.radiusPx > 0 ||
		shadow.enabled;

	return {
		outputWidth: spec.outputWidth,
		outputHeight: spec.outputHeight,
		innerWidth: spec.innerRect.width,
		innerHeight: spec.innerRect.height,
		borderRadius: spec.maskSpec.radiusPx,
		shadow: {
			enabled: shadow.enabled,
			offsetY: shadow.offsetY,
			blur: shadow.blurPx,
			spread: shadow.spreadPx,
			opacity: shadow.alpha,
		},
		backgroundColor,
		backgroundColorAlpha,
		backgroundGradient,
		backgroundImagePath,
		shouldApply,
	};
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

function buildTimelineFilterGraph(
	segments: ReadonlyArray<TimelineSegment>,
	hasAudio: boolean,
): {
	filterGraph: string;
	totalDuration: number;
} {
	const { filterGraph: videoGraph, totalDuration } =
		buildVideoTimelineFilterGraph(segments);

	if (!hasAudio) {
		return { filterGraph: videoGraph, totalDuration };
	}

	const audioGraph = buildAudioTimelineFilterGraph(segments);
	return {
		filterGraph: `${videoGraph};${audioGraph}`,
		totalDuration,
	};
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

export async function processVideoWithTimeline(
	inputPath: string,
	metadata: VideoMetadata,
	segments: ReadonlyArray<TimelineSegment>,
	projectConfig: unknown,
	options: VideoProcessingOptions = {},
	onProgress?: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const definedOptions = Object.fromEntries(
		Object.entries(options).filter(([, v]) => v !== undefined),
	) as VideoProcessingOptions;
	const opts = { ...DEFAULT_OPTIONS, ...definedOptions };
	const normalizedSegments = normalizeTimelineSegments(
		segments,
		metadata.duration,
	);
	const outputTempFile = await createTempFile(".mp4");
	const hasAudio = Boolean(metadata.audioCodec);
	const { filterGraph: timelineFilterGraph, totalDuration } =
		buildTimelineFilterGraph(normalizedSegments, hasAudio);
	const targetDuration = Math.max(totalDuration, 0.1);
	const editorLayout = getEditorRenderLayout(metadata, projectConfig);
	const useBackgroundImage =
		editorLayout.shouldApply && editorLayout.backgroundImagePath !== null;
	let backgroundImagePath = editorLayout.backgroundImagePath;
	let bgImageTempFile: TempFileHandle | null = null;

	if (
		useBackgroundImage &&
		backgroundImagePath &&
		(backgroundImagePath.startsWith("http://") ||
			backgroundImagePath.startsWith("https://"))
	) {
		try {
			const ext =
				backgroundImagePath.match(/\.(jpe?g|png|webp|bmp)/i)?.[0] ?? ".jpg";
			bgImageTempFile = await createTempFile(ext);
			const imgResponse = await fetchWithLoopbackBridge(backgroundImagePath, {
				signal: abortSignal ?? AbortSignal.timeout(60_000),
			});
			if (!imgResponse.ok) {
				throw new Error(`HTTP ${imgResponse.status}`);
			}
			const imgData = await imgResponse.arrayBuffer();
			await Bun.write(bgImageTempFile.path, imgData);
			console.log(
				`[processVideoWithTimeline] Downloaded background image (${imgData.byteLength} bytes) to ${bgImageTempFile.path}`,
			);
			backgroundImagePath = bgImageTempFile.path;
		} catch (err) {
			console.error(
				"[processVideoWithTimeline] Failed to download background image:",
				err,
			);
			await bgImageTempFile?.cleanup();
			bgImageTempFile = null;
		}
	}

	const ffmpegArgs: string[] = ["ffmpeg", "-threads", "2", "-i", inputPath];

	if (useBackgroundImage && backgroundImagePath) {
		ffmpegArgs.push(
			"-loop",
			"1",
			"-t",
			formatFfmpegNumber(targetDuration + 1),
			"-i",
			backgroundImagePath,
		);
	}

	const videoOutputLabel = editorLayout.shouldApply ? "[vfinal]" : "[vout]";
	const filterGraph = (() => {
		if (!editorLayout.shouldApply) return timelineFilterGraph;

		const filters: string[] = [timelineFilterGraph];

		if (useBackgroundImage) {
			filters.push(
				`[1:v]scale=${editorLayout.outputWidth}:${editorLayout.outputHeight}:force_original_aspect_ratio=increase,crop=${editorLayout.outputWidth}:${editorLayout.outputHeight}[bg]`,
			);
		} else if (editorLayout.backgroundGradient) {
			const geq = buildLinearGradientGeq({
				from: editorLayout.backgroundGradient.from,
				to: editorLayout.backgroundGradient.to,
				angle: editorLayout.backgroundGradient.angle,
				width: editorLayout.outputWidth,
				height: editorLayout.outputHeight,
			});
			filters.push(
				`nullsrc=s=${editorLayout.outputWidth}x${editorLayout.outputHeight}:d=${formatFfmpegNumber(targetDuration + 1)},format=rgb24,geq=r='${geq.r}':g='${geq.g}':b='${geq.b}'[bg]`,
			);
		} else {
			const backgroundColor =
				editorLayout.backgroundColorAlpha === 1
					? editorLayout.backgroundColor
					: `${editorLayout.backgroundColor}@${Number(editorLayout.backgroundColorAlpha.toFixed(6))}`;
			filters.push(
				`color=c=${backgroundColor}:s=${editorLayout.outputWidth}x${editorLayout.outputHeight}:d=${formatFfmpegNumber(targetDuration + 1)}[bg]`,
			);
		}

		filters.push(
			`[vout]scale=w=${editorLayout.innerWidth}:h=${editorLayout.innerHeight}:force_original_aspect_ratio=decrease,format=yuva420p,pad=w=${editorLayout.innerWidth}:h=${editorLayout.innerHeight}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0[vscaled]`,
		);

		if (editorLayout.borderRadius > 0) {
			const maxRadius = Math.max(
				1,
				Math.floor(
					Math.min(editorLayout.innerWidth, editorLayout.innerHeight) / 2,
				) - 1,
			);
			const radius = Math.min(editorLayout.borderRadius, maxRadius);
			filters.push(
				`[vscaled]geq=lum='p(X,Y)':a='if(gt(abs(W/2-X),W/2-${radius})*gt(abs(H/2-Y),H/2-${radius}),if(lte(hypot((W/2-${radius})-abs(W/2-X),(H/2-${radius})-abs(H/2-Y)),${radius}),255,0),255)'[vcard]`,
			);
		} else {
			filters.push("[vscaled]null[vcard]");
		}

		if (editorLayout.shadow.enabled) {
			const blurRadius = Math.max(1, Math.round(editorLayout.shadow.blur / 4));
			const spreadRadius = Math.max(0, Math.round(editorLayout.shadow.spread));
			const padPx = spreadRadius + blurRadius * 2;
			const paddedWidth = editorLayout.innerWidth + padPx * 2;
			const paddedHeight = editorLayout.innerHeight + padPx * 2;
			const dilationFilters =
				spreadRadius > 0
					? `${Array.from({ length: spreadRadius }, () => "dilation").join(",")},`
					: "";
			filters.push("[vcard]split[vcard-main][vcard-shadow]");
			filters.push(
				`[vcard-shadow]pad=w=iw+${padPx * 2}:h=ih+${padPx * 2}:x=${padPx}:y=${padPx}:color=0x00000000,alphaextract,${dilationFilters}boxblur=${blurRadius}:1[shadow-alpha]`,
			);
			filters.push(
				`color=c=black:s=${paddedWidth}x${paddedHeight}:d=${formatFfmpegNumber(targetDuration + 1)},format=yuva420p[shadow-color]`,
			);
			filters.push("[shadow-color][shadow-alpha]alphamerge[shadow-pre]");
			filters.push(
				`[shadow-pre]colorchannelmixer=aa=${editorLayout.shadow.opacity}[shadow]`,
			);
			filters.push(
				`[bg][shadow]overlay=(W-w)/2:(H-h)/2+${editorLayout.shadow.offsetY}:shortest=1[bg-shadow]`,
			);
			filters.push(
				"[bg-shadow][vcard-main]overlay=(W-w)/2:(H-h)/2:shortest=1[vfinal]",
			);
		} else {
			filters.push("[bg][vcard]overlay=(W-w)/2:(H-h)/2:shortest=1[vfinal]");
		}

		return filters.join(";");
	})();

	ffmpegArgs.push(
		"-filter_complex",
		filterGraph,
		"-map",
		videoOutputLabel,
		"-c:v",
		"libx264",
		"-preset",
		opts.preset,
		"-crf",
		opts.crf.toString(),
	);

	if (hasAudio) {
		ffmpegArgs.push("-map", "[aout]", "-c:a", "aac", "-b:a", opts.audioBitrate);
	} else {
		ffmpegArgs.push("-an");
	}

	ffmpegArgs.push(
		"-movflags",
		"+faststart",
		"-t",
		formatFfmpegNumber(targetDuration),
		"-progress",
		"pipe:2",
		"-y",
		outputTempFile.path,
	);

	console.log(
		`[processVideoWithTimeline] Running FFmpeg: ${ffmpegArgs.join(" ")}`,
	);

	const proc = spawn({
		cmd: ffmpegArgs,
		stdout: "pipe",
		stderr: "pipe",
	});
	const progressWatchdog = createProgressWatchdog(proc);
	let watchdogTimeoutMs = PROGRESS_STALL_TIMEOUT_MS;
	let reachedNearCompleteProgress = false;

	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			killProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	const stderrLines: string[] = [];
	const MAX_STDERR_LINES = 50;
	const totalDurationUs = targetDuration * 1_000_000;

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

				console.log(
					`[processVideoWithTimeline] FFmpeg stderr closed, waiting for exit. Last progress: ${reachedNearCompleteProgress ? ">=98%" : "<98%"}`,
				);

				const exitCode = await proc.exited;

				console.log(
					`[processVideoWithTimeline] FFmpeg exited with code ${exitCode}`,
				);

				if (exitCode !== 0) {
					if (progressWatchdog.isStalled()) {
						throw new Error(
							`FFmpeg progress stalled for ${watchdogTimeoutMs}ms`,
						);
					}
					const stderrOutput = stderrLines.join("\n");
					throw new Error(
						`FFmpeg exited with code ${exitCode}. Last stderr: ${stderrOutput}`,
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
		await bgImageTempFile?.cleanup();
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
