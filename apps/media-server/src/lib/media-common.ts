import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
	ALL_FORMATS,
	BufferSource,
	type Conversion,
	type ConversionAudioOptions,
	type ConversionOptions,
	type ConversionVideoOptions,
	CustomPathedSource,
	FilePathSource,
	FilePathTarget,
	Input,
	Mp4OutputFormat,
	Output,
	type OutputFormat,
	QUALITY_HIGH,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_VERY_HIGH,
	QUALITY_VERY_LOW,
	type Quality,
	type Source,
	UrlSource,
} from "mediabunny";
import { registerMediaEngine } from "./media-engine";

export type ProgressCallback = (progress: number, message: string) => void;

export const PROCESS_TIMEOUT_MS = 45 * 60 * 1000;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const mediaFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	cleanup?: () => void | Promise<void>,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			cleanupPromise = Promise.resolve()
				.then(() => cleanup?.())
				.then(() => undefined);
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

function isHttpUrl(path: string): boolean {
	try {
		const url = new URL(path);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isHlsPath(path: string): boolean {
	const normalized = (path.split("?")[0] ?? "").toLowerCase();
	return normalized.endsWith(".m3u8") || normalized.endsWith(".m3u");
}

function withInheritedQuery(path: string, query: string): string {
	if (!query || path.includes("?")) return path;

	try {
		const url = new URL(path);
		if (url.protocol !== "http:" && url.protocol !== "https:") return path;
		url.search = query;
		return url.toString();
	} catch {
		return path;
	}
}

function createHttpSource(path: string): Source {
	const query = new URL(path).search;
	const options = {
		fetchFn: mediaFetch,
		getRetryDelay: () => null,
	};

	return new CustomPathedSource(
		path,
		(request) =>
			new UrlSource(
				request.isRoot ? request.path : withInheritedQuery(request.path, query),
				options,
			),
	);
}

function createLocalHlsSource(path: string): Source {
	const options = {
		fetchFn: mediaFetch,
		getRetryDelay: () => null,
	};

	return new CustomPathedSource(path, async (request) => {
		if (isHttpUrl(request.path)) return new UrlSource(request.path, options);

		const normalizedPath = normalizeLocalPath(request.path);
		return isHlsPath(normalizedPath)
			? new BufferSource(await readFile(normalizedPath))
			: new FilePathSource(normalizedPath);
	});
}

export function createMediaInput(path: string): Input<Source> {
	registerMediaEngine();
	if (isHttpUrl(path)) {
		return new Input({
			source: createHttpSource(path),
			formats: ALL_FORMATS,
		});
	}

	const normalizedPath = normalizeLocalPath(path);
	if (!existsSync(normalizedPath)) {
		throw new Error(`Media input does not exist: ${normalizedPath}`);
	}

	return new Input({
		source: isHlsPath(normalizedPath)
			? createLocalHlsSource(normalizedPath)
			: new FilePathSource(normalizedPath),
		formats: ALL_FORMATS,
	});
}

export function parseBitrate(value: string | number | undefined): number {
	if (typeof value === "number") {
		return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 0;
	}

	if (!value) return 0;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
	if (!match) return 0;

	const amount = Number.parseFloat(match[1] ?? "0");
	const suffix = match[2]?.toLowerCase();
	if (suffix === "m") return Math.round(amount * 1_000_000);
	if (suffix === "k") return Math.round(amount * 1_000);
	return Math.round(amount);
}

export function bitrateQualityFromCrf(crf: number): Quality {
	if (crf <= 18) return QUALITY_VERY_HIGH;
	if (crf <= 22) return QUALITY_HIGH;
	if (crf <= 28) return QUALITY_MEDIUM;
	if (crf <= 35) return QUALITY_LOW;
	return QUALITY_VERY_LOW;
}

export function scaleToFitEven(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	if (width <= 0 || height <= 0) {
		return {
			width: Math.max(2, Math.floor(maxWidth / 2) * 2),
			height: Math.max(2, Math.floor(maxHeight / 2) * 2),
		};
	}

	const ratio = Math.min(1, maxWidth / width, maxHeight / height);
	return {
		width: Math.max(2, Math.floor((width * ratio) / 2) * 2),
		height: Math.max(2, Math.floor((height * ratio) / 2) * 2),
	};
}

export function normalizeLocalPath(path: string): string {
	try {
		const url = new URL(path);
		if (url.protocol === "file:") {
			return decodeURIComponent(url.pathname);
		}
	} catch {}
	return path;
}

export async function getSourceSize(path: string): Promise<number> {
	try {
		const url = new URL(path);
		if (url.protocol === "http:" || url.protocol === "https:") {
			const response = await mediaFetch(path, {
				method: "HEAD",
				signal: AbortSignal.timeout(10_000),
			});
			const contentLength = response.headers.get("content-length");
			return contentLength ? Number.parseInt(contentLength, 10) || 0 : 0;
		}
	} catch {}

	try {
		return (await stat(normalizeLocalPath(path))).size;
	} catch {
		return 0;
	}
}

export async function runConversion(options: {
	inputPath: string;
	outputPath: string;
	format?: OutputFormat;
	video?: ConversionVideoOptions | ConversionOptions["video"];
	audio?: ConversionAudioOptions | ConversionOptions["audio"];
	tracks?: ConversionOptions["tracks"];
	trim?: ConversionOptions["trim"];
	timeoutMs: number;
	progressMessage: string;
	onProgress?: ProgressCallback;
	abortSignal?: AbortSignal;
}): Promise<void> {
	const input = createMediaInput(options.inputPath);
	const output = new Output({
		format: options.format ?? new Mp4OutputFormat({ fastStart: "in-memory" }),
		target: new FilePathTarget(options.outputPath),
	});
	let conversion: Conversion | undefined;
	let abortCleanup: (() => void) | undefined;

	try {
		if (options.abortSignal?.aborted) {
			throw new Error("Media operation aborted");
		}

		const initializedConversion = await import("mediabunny").then(
			({ Conversion }) =>
				Conversion.init({
					input,
					output,
					video: options.video,
					audio: options.audio,
					tracks: options.tracks,
					trim: options.trim,
					showWarnings: false,
				}),
		);
		conversion = initializedConversion;

		if (!initializedConversion.isValid) {
			throw new Error(
				`Media conversion is not valid: ${initializedConversion.discardedTracks.map((track) => track.reason).join(", ")}`,
			);
		}

		initializedConversion.onProgress = (progress) => {
			options.onProgress?.(
				Math.round(progress * 100),
				`${options.progressMessage}: ${Math.round(progress * 100)}%`,
			);
		};

		if (options.abortSignal) {
			abortCleanup = () => {
				void conversion?.cancel();
			};
			options.abortSignal.addEventListener("abort", abortCleanup, {
				once: true,
			});
		}

		await withTimeout(initializedConversion.execute(), options.timeoutMs, () =>
			initializedConversion.cancel(),
		);
	} finally {
		if (abortCleanup) {
			options.abortSignal?.removeEventListener("abort", abortCleanup);
		}
		input.dispose();
	}
}
