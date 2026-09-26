import { COMPRESSION_BPP, type JobRequest } from "./protocol";

export function validateJobRequest(body: unknown): JobRequest | string {
	if (!body || typeof body !== "object") return "body must be a JSON object";
	const request = body as Record<string, unknown>;
	const recording = request.recording;
	if (
		typeof recording !== "string" ||
		!/^[A-Za-z0-9._/-]{1,512}$/.test(recording) ||
		recording.split("/").includes("..")
	) {
		return "recording must be a bucket prefix";
	}
	const integer = (value: unknown, min: number, max: number) =>
		value === undefined ||
		(typeof value === "number" &&
			Number.isInteger(value) &&
			value >= min &&
			value <= max);
	const positive = (value: unknown, max: number) =>
		value === undefined ||
		(typeof value === "number" &&
			Number.isFinite(value) &&
			value > 0 &&
			value <= max);
	if (!integer(request.fps, 1, 120))
		return "fps must be an integer from 1 to 120";
	const resolution = request.resolution;
	if (
		resolution !== undefined &&
		!(
			Array.isArray(resolution) &&
			resolution.length === 2 &&
			integer(resolution[0], 16, 7680) &&
			integer(resolution[1], 16, 4320)
		)
	) {
		return "resolution must be [width, height] within 16..7680 x 16..4320";
	}
	if (
		request.compression !== undefined &&
		!(
			typeof request.compression === "string" &&
			Object.hasOwn(COMPRESSION_BPP, request.compression)
		)
	) {
		return `compression must be one of ${Object.keys(COMPRESSION_BPP).join(", ")}`;
	}
	for (const [field, max] of [
		["maxChunks", 800],
		["chunks", 800],
		["chunksPerSlot", 64],
		["frameLimit", 10_000_000],
	] as const) {
		if (!integer(request[field], 1, max))
			return `${field} must be an integer from 1 to ${max}`;
	}
	for (const [field, max] of [
		["minChunkSeconds", 600],
		["chunkWorkSeconds", 600],
	] as const) {
		if (!positive(request[field], max))
			return `${field} must be a positive number up to ${max}`;
	}
	if (
		request.label !== undefined &&
		(typeof request.label !== "string" || request.label.length > 200)
	) {
		return "label must be a string of at most 200 characters";
	}
	if (
		request.duplicateStragglers !== undefined &&
		typeof request.duplicateStragglers !== "boolean"
	) {
		return "duplicateStragglers must be a boolean";
	}
	return request as JobRequest;
}

/** Audio sources: fetched whole for Studio Sound, never byte-range indexed. */
export const AUDIO_FILE = /\.(ogg|m4a|wav|mp3|aac|opus|flac)$/i;

export type SourceLimits = {
	metadataBytes: number;
	files: number;
	sourceBytes: number;
	sidecarBytes: number;
	moovBytes: number;
	exportSeconds: number;
};

export function sourceLimitsFromEnv(
	env: Record<string, string | undefined>,
): SourceLimits {
	const read = (name: string, fallback: number) => {
		const value = Number(env[name]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};
	return {
		metadataBytes: 4 << 20,
		files: read("RF_MAX_SOURCE_FILES", 4096),
		sourceBytes: read("RF_MAX_SOURCE_BYTES", 256 * 2 ** 30),
		sidecarBytes: 64 << 20,
		moovBytes: 256 << 20,
		exportSeconds: read("RF_MAX_EXPORT_SECONDS", 4 * 3600),
	};
}

/**
 * Bounds what one recording can make the coordinator and the fleet fetch and
 * hold. Recordings are uploaded by users, so their manifest is untrusted.
 */
export function checkManifestBounds(
	manifest: unknown,
	limits: SourceLimits,
): string | null {
	const files =
		manifest && typeof manifest === "object"
			? (manifest as { files?: unknown }).files
			: undefined;
	if (!Array.isArray(files)) return "manifest has no files list";
	if (files.length > limits.files) {
		return `manifest lists ${files.length} files (limit ${limits.files})`;
	}
	let total = 0;
	for (const file of files) {
		if (!file || typeof file !== "object")
			return "manifest entry is not an object";
		const { path, key, size } = file as Record<string, unknown>;
		if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
			return "manifest paths must be strings of 1 to 1024 characters";
		}
		if (key !== undefined && (typeof key !== "string" || key.length > 1024)) {
			return `manifest key for ${path} must be a string of at most 1024 characters`;
		}
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
			return `manifest size for ${path} must be a non-negative integer`;
		}
		if (
			!path.endsWith(".mp4") &&
			!AUDIO_FILE.test(path) &&
			size > limits.sidecarBytes
		) {
			return `${path} is ${size} bytes (limit ${limits.sidecarBytes})`;
		}
		total += size;
	}
	if (total > limits.sourceBytes) {
		return `recording is ${total} bytes (limit ${limits.sourceBytes})`;
	}
	return null;
}
