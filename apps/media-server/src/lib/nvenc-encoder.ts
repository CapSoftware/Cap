const DEFAULT_PRESET = "p5";
const DEFAULT_CQ_OFFSET = 2;
const DEFAULT_LOOKAHEAD = 20;
const MAX_LOOKAHEAD = 32;
const GOP_LENGTH = "250";
const NVENC_PRESETS = new Set(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
const NVDEC_CODECS = new Set(["h264", "hevc", "vp9", "av1"]);
const MAX_FALLBACK_REASON_LENGTH = 500;

export const NVENC_HWACCEL_INPUT_ARGS = [
	"-hwaccel",
	"cuda",
	"-hwaccel_output_format",
	"cuda",
];

export type VideoEncoderName = "libx264" | "capcodec" | "nvenc";
export type NvencJobKind = "process" | "edit";

export interface NvencOptions {
	preset: string;
	cqOffset: number;
	lookahead: number;
	spatialAq: boolean;
	temporalAq: boolean;
}

interface NvencAttempt {
	job: NvencJobKind;
	at: string;
	fellBack: boolean;
	reason: string | null;
}

const nvencStatus: {
	attempts: number;
	fallbacks: number;
	lastAttempt: NvencAttempt | null;
} = { attempts: 0, fallbacks: 0, lastAttempt: null };

type Env = Record<string, string | undefined>;

export function selectedVideoEncoder(env: Env = process.env): VideoEncoderName {
	const value = env.CAP_MEDIA_VIDEO_ENCODER;
	if (value === "capcodec" || value === "nvenc") return value;
	return "libx264";
}

function parseBoundedInt(
	raw: string | undefined,
	min: number,
	max: number,
): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) return undefined;
	return value;
}

function parseToggle(raw: string | undefined): boolean | undefined {
	const normalized = raw?.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "on") {
		return true;
	}
	if (normalized === "0" || normalized === "false" || normalized === "off") {
		return false;
	}
	return undefined;
}

export function nvencOptionsFromEnv(
	env: Env = process.env,
): NvencOptions | null {
	if (selectedVideoEncoder(env) !== "nvenc") return null;
	const preset = env.CAP_NVENC_PRESET?.trim().toLowerCase() ?? "";
	return {
		preset: NVENC_PRESETS.has(preset) ? preset : DEFAULT_PRESET,
		cqOffset:
			parseBoundedInt(env.CAP_NVENC_CQ_OFFSET, -51, 51) ?? DEFAULT_CQ_OFFSET,
		lookahead:
			parseBoundedInt(env.CAP_NVENC_LOOKAHEAD, 0, MAX_LOOKAHEAD) ??
			DEFAULT_LOOKAHEAD,
		spatialAq: parseToggle(env.CAP_NVENC_SPATIAL_AQ) ?? true,
		temporalAq: parseToggle(env.CAP_NVENC_TEMPORAL_AQ) ?? false,
	};
}

export function nvencCq(crf: number, cqOffset: number): string {
	const base = Number.isFinite(crf) ? crf : 23;
	const cq = Math.min(51, Math.max(1, base + cqOffset));
	return String(Math.round(cq * 1000) / 1000);
}

export function buildNvencEncodeArgs(
	options: NvencOptions,
	crf: number,
): string[] {
	return [
		"-c:v",
		"h264_nvenc",
		"-preset",
		options.preset,
		"-tune",
		"hq",
		"-rc",
		"vbr",
		"-cq",
		nvencCq(crf, options.cqOffset),
		"-b:v",
		"0",
		...(options.spatialAq ? ["-spatial-aq", "1"] : []),
		...(options.temporalAq ? ["-temporal-aq", "1"] : []),
		...(options.lookahead > 0
			? ["-rc-lookahead", String(options.lookahead)]
			: []),
		"-profile:v",
		"high",
		// h264_nvenc otherwise inherits the preset's GOP; pin libx264's default keyint.
		"-g",
		GOP_LENGTH,
	];
}

export function buildNvencScaleFilter(
	maxWidth: number,
	maxHeight: number,
): string {
	return `scale_cuda='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease:format=nv12,scale_cuda=trunc(iw/2)*2:trunc(ih/2)*2`;
}

// FFmpeg skips autorotation for hardware frames, so rotated sources decode on the CPU to keep the libx264 geometry.
export function canDecodeOnGpu(
	videoCodec: string,
	rotation: number | null,
): boolean {
	return NVDEC_CODECS.has(videoCodec) && rotation === 0;
}

export function nvencFallbackReason(
	error: unknown,
	aborted: boolean,
): string | null {
	if (aborted) return null;
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(-MAX_FALLBACK_REASON_LENGTH) || "unknown error";
}

export function recordNvencAttempt(
	job: NvencJobKind,
	fallbackReason: string | null = null,
): void {
	nvencStatus.attempts += 1;
	if (fallbackReason !== null) nvencStatus.fallbacks += 1;
	nvencStatus.lastAttempt = {
		job,
		at: new Date().toISOString(),
		fellBack: fallbackReason !== null,
		reason: fallbackReason,
	};
}

export function logNvencFallback(details: {
	job: NvencJobKind;
	sourceCodec: string;
	gpuDecode: boolean;
	reason: string;
}): void {
	console.warn(
		JSON.stringify({
			event: "nvenc_fallback_to_libx264",
			timestamp: new Date().toISOString(),
			...details,
		}),
	);
}

export function getVideoEncoderStatus(env: Env = process.env) {
	const active = selectedVideoEncoder(env);
	return {
		active,
		nvenc:
			active === "nvenc"
				? {
						attempts: nvencStatus.attempts,
						fallbacks: nvencStatus.fallbacks,
						lastAttempt: nvencStatus.lastAttempt,
					}
				: null,
	};
}
