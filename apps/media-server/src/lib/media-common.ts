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
import { createGuardedMediaFetch } from "./media-address-guard";
import { registerMediaEngine } from "./media-engine";

export {
	createGuardedMediaFetch,
	isPrivateHostLiteral,
} from "./media-address-guard";

export type ProgressCallback = (progress: number, message: string) => void;

export const PROCESS_TIMEOUT_MS = 45 * 60 * 1000;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const mediaFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export function decodeThreadsFromEnv(
	name: string,
	fallback: number,
	env: Record<string, string | undefined> = process.env,
): string {
	const raw = env[name]?.trim();
	if (!raw) return String(fallback);
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > 64) {
		return String(fallback);
	}
	return String(value);
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

export function isHlsPath(path: string): boolean {
	let name = path.split("?")[0] ?? "";
	if (isHttpUrl(path)) name = new URL(path).pathname;
	const normalized = name.toLowerCase();
	return normalized.endsWith(".m3u8") || normalized.endsWith(".m3u");
}

function childRefusal(child: string, root: URL): string | null {
	let url: URL;
	try {
		url = new URL(child);
	} catch {
		return "a remote playlist referenced a file this server cannot address";
	}
	return url.origin === root.origin
		? null
		: "a remote playlist may only reference files on its own host";
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

// A refused entry is answered with an empty file, not an exception: thrown
// from here the error escapes MediaBunny unhandled. The reason is reported
// through onRefused so the caller can fail the input for what it was.
function createHttpSource(
	path: string,
	onRefused: (reason: string) => void,
): Source {
	const root = new URL(path);
	const options = {
		fetchFn: createGuardedMediaFetch(path),
		getRetryDelay: () => null,
	};

	return new CustomPathedSource(path, (request) => {
		if (request.isRoot) return new UrlSource(request.path, options);
		const child = withInheritedQuery(request.path, root.search);
		const refusal = childRefusal(child, root);
		if (refusal) {
			onRefused(refusal);
			return new BufferSource(new Uint8Array(0));
		}
		return new UrlSource(child, options);
	});
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

// MediaBunny's dispose() chains onto the demuxer promise without a catch. For
// an input whose format was never recognised that promise is rejected, so
// disposing it surfaced as an unhandled rejection for every unreadable upload.
function withSafeDispose<S extends Source>(input: Input<S>): Input<S> {
	const dispose = input.dispose.bind(input);
	input.dispose = () => {
		const internal = input as unknown as {
			_demuxerPromise?: Promise<{ dispose(): void }>;
		};
		internal._demuxerPromise = internal._demuxerPromise?.catch(() => ({
			dispose() {},
		}));
		dispose();
	};
	return input;
}

const refusedInputs = new WeakMap<Input<Source>, string>();

// Why a remote input was not allowed to read something it referenced, if it
// was. An input that was refused anything must not be used.
export function mediaInputRefusal(input: Input<Source>): string | undefined {
	return refusedInputs.get(input);
}

export function createMediaInput(path: string): Input<Source> {
	registerMediaEngine();
	if (isHttpUrl(path)) {
		const input: Input<Source> = withSafeDispose(
			new Input({
				source: createHttpSource(path, (reason) => {
					if (!refusedInputs.has(input)) refusedInputs.set(input, reason);
				}),
				formats: ALL_FORMATS,
			}),
		);
		return input;
	}

	const normalizedPath = normalizeLocalPath(path);
	if (!existsSync(normalizedPath)) {
		throw new Error(`Media input does not exist: ${normalizedPath}`);
	}

	return withSafeDispose(
		new Input({
			source: isHlsPath(normalizedPath)
				? createLocalHlsSource(normalizedPath)
				: new FilePathSource(normalizedPath),
			formats: ALL_FORMATS,
		}),
	);
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
	if (/^https?:\/\//i.test(path)) {
		const response = await createGuardedMediaFetch(path)(path, {
			headers: { Range: "bytes=0-0" },
			signal: AbortSignal.timeout(10_000),
		});
		try {
			const length =
				response.status === 206
					? response.headers
							.get("content-range")
							?.match(/^bytes 0-0\/(\d+)$/)?.[1]
					: response.status === 200
						? response.headers.get("content-length")
						: undefined;
			const size = Number(length);
			if (!Number.isSafeInteger(size) || size <= 0) {
				throw new Error("Media input size is unavailable");
			}
			return size;
		} finally {
			await response.body?.cancel().catch(() => {});
		}
	}

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
