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
import { MediaInputPolicyError } from "./media-input-policy";

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

const MAX_MEDIA_REDIRECTS = 5;

function isPrivateIpv4(a: number, b: number): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

// The eight 16-bit groups of an IPv6 literal, or null when it is not one.
// URL parsing writes an embedded IPv4 address as two hex groups, so both
// spellings are read.
function ipv6Groups(host: string): number[] | null {
	if (!host.includes(":")) return null;
	let text = host;
	const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(2).map(Number) as [
			number,
			number,
			number,
			number,
		];
		if ([a, b, c, d].some((part) => part > 255)) return null;
		text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) =>
		part === ""
			? []
			: part.split(":").map((group) => Number.parseInt(group, 16));
	const head = parse(halves[0] ?? "");
	const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
	return groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

// Loopback, private, link-local (cloud metadata) and unspecified addresses,
// written as literals. Names are not resolved here.
export function isPrivateHostLiteral(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) return isPrivateIpv4(Number(v4[1]), Number(v4[2]));
	const groups = ipv6Groups(host);
	if (!groups) return false;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	// ::, ::1, and IPv4 addresses carried in IPv6 (mapped ::ffff:a.b.c.d and
	// the older compatible ::a.b.c.d form).
	if (leadingZero && (g5 === 0 || g5 === 0xffff)) {
		if (g5 === 0 && g6 === 0 && g7 <= 1) return true;
		return isPrivateIpv4(g6 >> 8, g6 & 0xff);
	}
	return (
		(g0 & 0xfe00) === 0xfc00 ||
		(g0 & 0xffc0) === 0xfe80 ||
		(g0 & 0xffc0) === 0xfec0
	);
}

function isHttpProtocol(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

// A remote input is only ever given by the web app, but what it leads to is
// not: a playlist names other files and a server can redirect. Both are held
// to the host the input came from, so neither can point this server at an
// address of someone's choosing.
export function createGuardedMediaFetch(rootUrl: string): typeof fetch {
	const root = new URL(rootUrl);
	const guarded = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		let url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url,
		);
		for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
			const response = await mediaFetch(url, { ...init, redirect: "manual" });
			const location = response.headers.get("location");
			if (response.status < 300 || response.status >= 400 || !location) {
				return response;
			}
			await response.body?.cancel().catch(() => {});
			const next = new URL(location, url);
			if (
				!isHttpProtocol(next) ||
				(next.origin !== root.origin && isPrivateHostLiteral(next.hostname))
			) {
				throw new MediaInputPolicyError(
					"the media location redirected to an address that is not allowed",
				);
			}
			url = next;
		}
		throw new Error("Media input redirected too many times");
	};
	return guarded as typeof fetch;
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
		const response = await mediaFetch(path, {
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
