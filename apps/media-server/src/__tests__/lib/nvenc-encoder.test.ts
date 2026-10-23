import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { VideoMetadata } from "../../lib/job-manager";
import { decodeThreadsFromEnv } from "../../lib/media-common";
import {
	buildTranscodeEditArgs,
	renderEditedVideo,
} from "../../lib/media-edit";
import { probeVideo } from "../../lib/media-probe";
import {
	buildProcessVideoArgs,
	type ProcessVideoArgsInput,
	pickMobileSafeH264Level,
	processVideo,
} from "../../lib/media-video";
import {
	buildNvencEncodeArgs,
	canDecodeOnGpu,
	encodeAttemptsBudgetMs,
	fitWithinEven,
	getVideoEncoderStatus,
	type NvencOptions,
	nvencCq,
	nvencFallbackReason,
	nvencOptionsFromEnv,
	recordNvencAttempt,
	selectedVideoEncoder,
} from "../../lib/nvenc-encoder";

const enabled = { CAP_MEDIA_VIDEO_ENCODER: "nvenc" };
const defaults: NvencOptions = {
	preset: "p1",
	cqOffset: 8,
	lookahead: 0,
	spatialAq: true,
	temporalAq: false,
	gpuDecodeCodecs: ["hevc", "av1"],
};
const opts: ProcessVideoArgsInput["opts"] = {
	maxWidth: 1920,
	maxHeight: 1080,
	preset: "medium",
	crf: 23,
	audioBitrate: "128k",
};
const nvencVideoArgs = [
	"-c:v",
	"h264_nvenc",
	"-preset",
	"p1",
	"-tune",
	"hq",
	"-rc",
	"vbr",
	"-cq",
	"31",
	"-b:v",
	"0",
	"-spatial-aq",
	"1",
	"-profile:v",
	"high",
	"-g",
	"250",
];
const gpuScale = "scale_cuda=format=nv12";
const cpuScale =
	"scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";

function metadata(
	width: number,
	height: number,
	videoCodec: string,
): VideoMetadata {
	return {
		duration: 10,
		width,
		height,
		fps: 30,
		videoCodec,
		audioCodec: "aac",
		audioChannels: 2,
		sampleRate: 48_000,
		bitrate: 0,
		fileSize: 0,
	};
}

function processArgs(
	source: VideoMetadata,
	overrides: Partial<ProcessVideoArgsInput> = {},
): ProcessVideoArgsInput {
	return {
		inputPath: "in.mp4",
		outputPath: "out.mp4",
		videoCodec: source.videoCodec,
		hasAudio: true,
		opts,
		targetH264Level: pickMobileSafeH264Level(source, opts).ffmpegValue,
		normalizeH264Level: false,
		videoTranscode: true,
		audioTranscode: false,
		extraInputArgs: [],
		extraOutputArgs: [],
		decodeThreads: "2",
		sourceWidth: source.width,
		sourceHeight: source.height,
		...overrides,
	};
}

const outputTail = [
	"-c:a",
	"copy",
	"-movflags",
	"+faststart",
	"-progress",
	"pipe:2",
	"-y",
	"out.mp4",
];

describe("nvenc encoder selection", () => {
	test("is off unless CAP_MEDIA_VIDEO_ENCODER is nvenc", () => {
		expect(selectedVideoEncoder({})).toBe("libx264");
		expect(selectedVideoEncoder({ CAP_MEDIA_VIDEO_ENCODER: "x264" })).toBe(
			"libx264",
		);
		expect(selectedVideoEncoder({ CAP_MEDIA_VIDEO_ENCODER: "capcodec" })).toBe(
			"capcodec",
		);
		expect(selectedVideoEncoder(enabled)).toBe("nvenc");
		expect(nvencOptionsFromEnv({})).toBeNull();
		expect(
			nvencOptionsFromEnv({ CAP_MEDIA_VIDEO_ENCODER: "capcodec" }),
		).toBeNull();
		expect(getVideoEncoderStatus({})).toEqual({
			active: "libx264",
			nvenc: null,
		});
		expect(getVideoEncoderStatus(enabled, false)).toEqual({
			active: "nvenc",
			nvenc: null,
		});
	});

	test("uses p1, cq = crf + 8, no lookahead and spatial AQ by default", () => {
		expect(nvencOptionsFromEnv(enabled)).toEqual(defaults);
	});

	test("reads tuning overrides from the environment", () => {
		expect(
			nvencOptionsFromEnv({
				...enabled,
				CAP_NVENC_PRESET: " P7 ",
				CAP_NVENC_CQ_OFFSET: "-3",
				CAP_NVENC_LOOKAHEAD: "0",
				CAP_NVENC_SPATIAL_AQ: "off",
				CAP_NVENC_TEMPORAL_AQ: "1",
			}),
		).toEqual({
			preset: "p7",
			cqOffset: -3,
			lookahead: 0,
			spatialAq: false,
			temporalAq: true,
			gpuDecodeCodecs: ["hevc", "av1"],
		});
		expect(
			nvencOptionsFromEnv({
				...enabled,
				CAP_NVENC_GPU_DECODE_CODECS: "h264, HEVC,vp8,nope",
			})?.gpuDecodeCodecs,
		).toEqual(["h264", "hevc"]);
	});

	test("ignores invalid tuning overrides", () => {
		expect(
			nvencOptionsFromEnv({
				...enabled,
				CAP_NVENC_PRESET: "slow",
				CAP_NVENC_CQ_OFFSET: "2.5",
				CAP_NVENC_LOOKAHEAD: "64",
				CAP_NVENC_SPATIAL_AQ: "maybe",
				CAP_NVENC_TEMPORAL_AQ: "",
			}),
		).toEqual(defaults);
	});

	test("maps crf to a bounded cq", () => {
		expect(nvencCq(23, 2)).toBe("25");
		expect(nvencCq(18, 2)).toBe("20");
		expect(nvencCq(20.5, 0)).toBe("20.5");
		expect(nvencCq(50, 5)).toBe("51");
		expect(nvencCq(0, -4)).toBe("1");
		expect(nvencCq(Number.NaN, 2)).toBe("25");
	});

	test("builds constant-quality VBR encoder args", () => {
		expect(buildNvencEncodeArgs(defaults, 23)).toEqual(nvencVideoArgs);
		expect(
			buildNvencEncodeArgs(
				{ ...defaults, lookahead: 0, spatialAq: false, temporalAq: true },
				18,
			),
		).toEqual([
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p1",
			"-tune",
			"hq",
			"-rc",
			"vbr",
			"-cq",
			"26",
			"-b:v",
			"0",
			"-temporal-aq",
			"1",
			"-profile:v",
			"high",
			"-g",
			"250",
		]);
	});

	test("fits the GPU resize to the CPU path's box and even dimensions", () => {
		expect(fitWithinEven(3840, 2160, 1920, 1080)).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(fitWithinEven(3024, 1964, 1920, 1080)).toEqual({
			width: 1662,
			height: 1080,
		});
		expect(fitWithinEven(1079, 1919, 1920, 1080)).toEqual({
			width: 606,
			height: 1080,
		});
		expect(fitWithinEven(1281, 721, 1920, 1080)).toEqual({
			width: 1280,
			height: 720,
		});
	});

	test("decodes on the GPU only for configured, unrotated codecs", () => {
		for (const codec of ["hevc", "av1"]) {
			expect(canDecodeOnGpu(codec, 0)).toBe(true);
		}
		expect(canDecodeOnGpu("h264", 0)).toBe(false);
		expect(canDecodeOnGpu("h264", 0, ["h264"])).toBe(true);
		expect(canDecodeOnGpu("vp8", 0)).toBe(false);
		expect(canDecodeOnGpu("prores", 0)).toBe(false);
		expect(canDecodeOnGpu("hevc", 90)).toBe(false);
		expect(canDecodeOnGpu("h264", null)).toBe(false);
	});
});

describe("nvenc fallback", () => {
	test("reserves job time for the libx264 retry only when nvenc is on", () => {
		expect(encodeAttemptsBudgetMs(60_000, {})).toBe(60_000);
		expect(encodeAttemptsBudgetMs(60_000, enabled)).toBe(120_000);
	});

	test("falls back to libx264 on any failure that was not a cancellation", () => {
		expect(
			nvencFallbackReason(
				new Error("FFmpeg exited with code 1. Last stderr: No device"),
				false,
			),
		).toBe("FFmpeg exited with code 1. Last stderr: No device");
		expect(nvencFallbackReason("boom", false)).toBe("boom");
		expect(
			nvencFallbackReason(
				new Error(
					"https://bucket.s3.amazonaws.com/u/v/raw.mp4?X-Amz-Signature=abc: Server returned 403",
				),
				false,
			),
		).toBe("<url> Server returned 403");
		expect(nvencFallbackReason(new Error(""), false)).toBe("unknown error");
		expect(
			nvencFallbackReason(new Error("x".repeat(2000)), false),
		).toHaveLength(500);
		expect(nvencFallbackReason(new Error("killed"), true)).toBeNull();
	});

	test("reports the last attempt through the encoder status", () => {
		const before = getVideoEncoderStatus(enabled).nvenc;
		recordNvencAttempt("process", "No NVENC capable devices found");
		const fellBack = getVideoEncoderStatus(enabled).nvenc;
		expect(fellBack?.attempts).toBe((before?.attempts ?? 0) + 1);
		expect(fellBack?.fallbacks).toBe((before?.fallbacks ?? 0) + 1);
		expect(fellBack?.lastAttempt).toMatchObject({
			job: "process",
			fellBack: true,
			reason: "No NVENC capable devices found",
		});
		recordNvencAttempt("edit");
		const succeeded = getVideoEncoderStatus(enabled).nvenc;
		expect(succeeded?.fallbacks).toBe(fellBack?.fallbacks);
		expect(succeeded?.lastAttempt).toMatchObject({
			job: "edit",
			fellBack: false,
			reason: null,
		});
	});
});

describe("process video args", () => {
	test("keeps the default libx264 args unchanged", () => {
		const source = metadata(3024, 1964, "h264");
		expect(buildProcessVideoArgs(processArgs(source))).toEqual([
			"ffmpeg",
			"-threads",
			"2",
			"-i",
			"in.mp4",
			"-c:v",
			"libx264",
			"-preset",
			"medium",
			"-crf",
			"23",
			"-vf",
			cpuScale,
			"-pix_fmt",
			"yuv420p",
			"-level:v",
			"4.2",
			...outputTail,
		]);
	});

	test("runs a 3024x1964 H.264 source fully on the GPU", () => {
		const source = metadata(3024, 1964, "h264");
		expect(
			buildProcessVideoArgs(
				processArgs(source, {
					nvenc: { options: defaults, gpuDecode: true },
				}),
			),
		).toEqual([
			"ffmpeg",
			"-threads",
			"2",
			"-hwaccel",
			"cuda",
			"-hwaccel_output_format",
			"cuda",
			"-c:v",
			"h264_cuvid",
			"-resize",
			"1662x1080",
			"-i",
			"in.mp4",
			...nvencVideoArgs,
			"-vf",
			gpuScale,
			"-bsf:v",
			"h264_metadata=level=4.2",
			...outputTail,
		]);
	});

	test("runs a 4K HEVC source fully on the GPU", () => {
		const source = metadata(3840, 2160, "hevc");
		expect(
			buildProcessVideoArgs(
				processArgs(source, {
					inputPath: "in.mov",
					audioTranscode: true,
					nvenc: { options: defaults, gpuDecode: true },
				}),
			),
		).toEqual([
			"ffmpeg",
			"-threads",
			"2",
			"-hwaccel",
			"cuda",
			"-hwaccel_output_format",
			"cuda",
			"-c:v",
			"hevc_cuvid",
			"-resize",
			"1920x1080",
			"-i",
			"in.mov",
			...nvencVideoArgs,
			"-vf",
			gpuScale,
			"-bsf:v",
			"h264_metadata=level=4.2",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			"-progress",
			"pipe:2",
			"-y",
			"out.mp4",
		]);
	});

	test("keeps -bf 0 for a 1080p VP9 webm", () => {
		const source = metadata(1920, 1080, "vp9");
		expect(
			buildProcessVideoArgs(
				processArgs(source, {
					inputPath: "in.webm",
					audioTranscode: true,
					nvenc: { options: defaults, gpuDecode: true },
				}),
			),
		).toEqual([
			"ffmpeg",
			"-threads",
			"2",
			"-hwaccel",
			"cuda",
			"-hwaccel_output_format",
			"cuda",
			"-c:v",
			"vp9_cuvid",
			"-i",
			"in.webm",
			...nvencVideoArgs,
			"-vf",
			gpuScale,
			"-bsf:v",
			"h264_metadata=level=4.2",
			"-bf",
			"0",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			"-progress",
			"pipe:2",
			"-y",
			"out.mp4",
		]);
	});

	test("scales on the CPU before NVENC when the GPU cannot decode", () => {
		const source = metadata(1280, 720, "vp8");
		expect(
			buildProcessVideoArgs(
				processArgs(source, {
					inputPath: "in.webm",
					decodeThreads: "4",
					extraInputArgs: ["-fflags", "+genpts"],
					extraOutputArgs: ["-max_muxing_queue_size", "4096"],
					nvenc: { options: defaults, gpuDecode: false },
				}),
			),
		).toEqual([
			"ffmpeg",
			"-threads",
			"4",
			"-fflags",
			"+genpts",
			"-i",
			"in.webm",
			...nvencVideoArgs,
			"-vf",
			cpuScale,
			"-pix_fmt",
			"yuv420p",
			"-bsf:v",
			"h264_metadata=level=4.2",
			"-bf",
			"0",
			"-c:a",
			"copy",
			"-movflags",
			"+faststart",
			"-max_muxing_queue_size",
			"4096",
			"-progress",
			"pipe:2",
			"-y",
			"out.mp4",
		]);
	});

	test("never touches level normalization or stream copies", () => {
		const source = metadata(1920, 1080, "h264");
		const nvenc = { options: defaults, gpuDecode: false };
		expect(
			buildProcessVideoArgs(
				processArgs(source, { normalizeH264Level: true, nvenc }),
			),
		).toEqual([
			"ffmpeg",
			"-threads",
			"2",
			"-i",
			"in.mp4",
			"-c:v",
			"copy",
			"-bsf:v",
			"h264_metadata=level=4.2",
			...outputTail,
		]);
		expect(
			buildProcessVideoArgs(
				processArgs(source, { videoTranscode: false, hasAudio: false }),
			),
		).toEqual([
			"ffmpeg",
			"-threads",
			"2",
			"-i",
			"in.mp4",
			"-c:v",
			"copy",
			"-an",
			...outputTail.slice(2),
		]);
	});
});

describe("edit re-encode args", () => {
	const range = [{ start: 1, end: 3 }];

	test("swaps libx264 for NVENC and keeps the rest of the edit graph", () => {
		const libx264 = buildTranscodeEditArgs("in.mp4", range, "out.mp4", true);
		const nvenc = buildTranscodeEditArgs(
			"in.mp4",
			range,
			"out.mp4",
			true,
			30,
			defaults,
		);
		expect(libx264.slice(libx264.indexOf("[v]") + 1)).toEqual([
			"-c:v",
			"libx264",
			"-preset",
			"fast",
			"-crf",
			"18",
			"-pix_fmt",
			"yuv420p",
			"-enc_time_base:v",
			"1/30",
			"-map",
			"[a]",
			"-c:a",
			"aac",
			"-b:a",
			"160k",
			"-movflags",
			"+faststart",
			"out.mp4",
		]);
		expect(nvenc).toEqual([
			"ffmpeg",
			"-hide_banner",
			"-y",
			"-ss",
			"1.000",
			"-t",
			"2.000",
			"-i",
			"in.mp4",
			"-filter_complex",
			"[0:v:0]fps=30,setpts=PTS-STARTPTS[v0];[0:a:0]asetpts=PTS-STARTPTS[a0];[v0][a0]concat=n=1:v=1:a=1[v][a]",
			"-map",
			"[v]",
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p1",
			"-tune",
			"hq",
			"-rc",
			"vbr",
			"-cq",
			"26",
			"-b:v",
			"0",
			"-spatial-aq",
			"1",
			"-profile:v",
			"high",
			"-g",
			"250",
			"-pix_fmt",
			"yuv420p",
			"-enc_time_base:v",
			"1/30",
			"-map",
			"[a]",
			"-c:a",
			"aac",
			"-b:a",
			"160k",
			"-movflags",
			"+faststart",
			"out.mp4",
		]);
	});
});

describe("decode thread overrides", () => {
	test("keep today's defaults unless set to a valid count", () => {
		const name = "MEDIA_SERVER_VERIFY_DECODE_THREADS";
		expect(decodeThreadsFromEnv(name, 1, {})).toBe("1");
		expect(decodeThreadsFromEnv(name, 1, { [name]: " " })).toBe("1");
		expect(decodeThreadsFromEnv(name, 1, { [name]: "4" })).toBe("4");
		expect(decodeThreadsFromEnv(name, 2, { [name]: "0" })).toBe("0");
		expect(decodeThreadsFromEnv(name, 2, { [name]: "-1" })).toBe("2");
		expect(decodeThreadsFromEnv(name, 2, { [name]: "1.5" })).toBe("2");
		expect(decodeThreadsFromEnv(name, 2, { [name]: "65" })).toBe("2");
		expect(decodeThreadsFromEnv(name, 2, { [name]: "auto" })).toBe("2");
	});
});

describe("nvenc jobs on hosts without an NVENC device", () => {
	const fixture = join(
		import.meta.dir,
		"..",
		"fixtures",
		"test-with-audio.mp4",
	);

	async function withNvencEnv<T>(run: () => Promise<T>): Promise<T> {
		const previous = process.env.CAP_MEDIA_VIDEO_ENCODER;
		process.env.CAP_MEDIA_VIDEO_ENCODER = "nvenc";
		try {
			return await run();
		} finally {
			if (previous === undefined) delete process.env.CAP_MEDIA_VIDEO_ENCODER;
			else process.env.CAP_MEDIA_VIDEO_ENCODER = previous;
		}
	}

	function expectRecordedAttempt(job: "process" | "edit", attempts: number) {
		const status = getVideoEncoderStatus(enabled).nvenc;
		expect(status?.attempts).toBe(attempts + 1);
		expect(status?.lastAttempt?.job).toBe(job);
		if (status?.lastAttempt?.fellBack) {
			expect(status.lastAttempt.reason).toBeString();
		}
	}

	test("does not start the encoder once the job is cancelled", async () => {
		const metadata = await probeVideo(`file://${fixture}`);
		const attempts = getVideoEncoderStatus(enabled).nvenc?.attempts ?? 0;
		const controller = new AbortController();
		controller.abort();
		await expect(
			withNvencEnv(() =>
				processVideo(
					fixture,
					metadata,
					{ maxWidth: 160, maxHeight: 120 },
					undefined,
					controller.signal,
				),
			),
		).rejects.toThrow("Video processing was cancelled");
		expect(getVideoEncoderStatus(enabled).nvenc?.attempts ?? 0).toBe(attempts);
	});

	test("still produces the transcode", async () => {
		const metadata = await probeVideo(`file://${fixture}`);
		const attempts = getVideoEncoderStatus(enabled).nvenc?.attempts ?? 0;
		const output = await withNvencEnv(() =>
			processVideo(fixture, metadata, { maxWidth: 160, maxHeight: 120 }),
		);
		try {
			const result = await probeVideo(`file://${output.path}`);
			expect(result.videoCodec).toBe("h264");
			expect(result.width).toBe(160);
			expect(result.height).toBe(120);
			expect(result.audioCodec).toBe("aac");
			expectRecordedAttempt("process", attempts);
		} finally {
			await output.cleanup();
		}
	});

	test("still renders the edit", async () => {
		const metadata = await probeVideo(`file://${fixture}`);
		const attempts = getVideoEncoderStatus(enabled).nvenc?.attempts ?? 0;
		const output = await withNvencEnv(() =>
			renderEditedVideo({
				inputPath: fixture,
				keepRanges: [{ start: 0, end: 0.5 }],
				metadata,
			}),
		);
		try {
			const result = await probeVideo(`file://${output.path}`);
			expect(result.videoCodec).toBe("h264");
			expect(result.audioCodec).toBe("aac");
			expectRecordedAttempt("edit", attempts);
		} finally {
			await output.cleanup();
		}
	});
});
