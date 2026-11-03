import { FfmpegExitError } from "./ffmpeg-errors";
import { redactLogText } from "./log-redaction";

const DEFAULT_PRESET = "p1";
const DEFAULT_CQ_OFFSET = 8;
const DEFAULT_LOOKAHEAD = 0;
const MAX_LOOKAHEAD = 32;
const GOP_LENGTH = "250";
const NVENC_PRESETS = new Set(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
const NVDEC_CODECS = new Set(["h264", "hevc", "vp9", "av1"]);
// H.264 and VP9 decode faster on the host CPU than on L4 NVDEC; HEVC and AV1 do not.
const DEFAULT_GPU_DECODE_CODECS = ["hevc", "av1"];
const MAX_FALLBACK_REASON_LENGTH = 500;
const MAX_FFMPEG_CAUSE_LENGTH = 300;

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
	gpuDecodeCodecs: string[];
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
		gpuDecodeCodecs: parseGpuDecodeCodecs(env.CAP_NVENC_GPU_DECODE_CODECS),
	};
}

function parseGpuDecodeCodecs(raw: string | undefined): string[] {
	if (raw === undefined || raw.trim() === "") return DEFAULT_GPU_DECODE_CODECS;
	return raw
		.split(",")
		.map((codec) => codec.trim().toLowerCase())
		.filter((codec) => NVDEC_CODECS.has(codec));
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

// Mirrors the CPU filter chain: fit within the box keeping aspect (rounded like libavfilter), then floor to even.
export function fitWithinEven(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	let w = Math.min(maxWidth, width);
	let h = Math.min(maxHeight, height);
	const tmpW = Math.round((h * width) / height);
	const tmpH = Math.round((w * height) / width);
	w = Math.min(tmpW, w);
	h = Math.min(tmpH, h);
	return { width: Math.trunc(w / 2) * 2, height: Math.trunc(h / 2) * 2 };
}

// cuvid resizes inside NVDEC for free; scale_cuda then only converts 10-bit surfaces and passes 8-bit through.
export function buildGpuDecodeInputArgs(
	videoCodec: string,
	source: { width: number; height: number },
	target: { width: number; height: number },
): string[] {
	return [
		...NVENC_HWACCEL_INPUT_ARGS,
		"-c:v",
		`${videoCodec}_cuvid`,
		...(target.width !== source.width || target.height !== source.height
			? ["-resize", `${target.width}x${target.height}`]
			: []),
	];
}

export const GPU_DECODE_FORMAT_FILTER = "scale_cuda=format=nv12";

// FFmpeg skips autorotation for hardware frames, so rotated sources decode on the CPU to keep the libx264 geometry.
export function canDecodeOnGpu(
	videoCodec: string,
	rotation: number | null,
	gpuDecodeCodecs: string[] = DEFAULT_GPU_DECODE_CODECS,
): boolean {
	return gpuDecodeCodecs.includes(videoCodec) && rotation === 0;
}

// A failed NVENC encode is retried on libx264 with a fresh timeout, so the job
// deadline has to leave room for both attempts.
export function encodeAttemptsBudgetMs(
	encodeTimeoutMs: number,
	env: Env = process.env,
): number {
	return selectedVideoEncoder(env) === "nvenc"
		? encodeTimeoutMs * 2
		: encodeTimeoutMs;
}

export function nvencFallbackReason(
	error: unknown,
	aborted: boolean,
): string | null {
	if (aborted) return null;
	const message = redactLogText(
		error instanceof Error ? error.message : String(error),
	);
	// The message tail is mostly -progress output; the encoder's own error is printed earlier.
	const cause =
		error instanceof FfmpegExitError && error.errorLines.length > 0
			? `${redactLogText(error.errorLines.join(" | ")).slice(0, MAX_FFMPEG_CAUSE_LENGTH)} || `
			: "";
	return (
		(
			cause + message.slice(-(MAX_FALLBACK_REASON_LENGTH - cause.length))
		).trim() || "unknown error"
	);
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

export function getVideoEncoderStatus(
	env: Env = process.env,
	includeDetails = true,
) {
	const active = selectedVideoEncoder(env);
	return {
		active,
		nvenc:
			active === "nvenc" && includeDetails
				? {
						attempts: nvencStatus.attempts,
						fallbacks: nvencStatus.fallbacks,
						lastAttempt: nvencStatus.lastAttempt,
					}
				: null,
	};
}
