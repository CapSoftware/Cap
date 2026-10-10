import { describe, expect, test } from "bun:test";
import {
	assertCapcodecBinary,
	buildCapcodecDecodeArgs,
	buildCapcodecEncodeArgs,
	capcodecOptionsForJob,
	capcodecOptionsFromEnv,
	fitEvenSize,
	frameRateFraction,
	remainingTimeoutMs,
} from "../../lib/capcodec-encoder";

const enabled = { CAP_MEDIA_VIDEO_ENCODER: "capcodec" };

describe("capcodec encoder integration", () => {
	test("is disabled unless CAP_MEDIA_VIDEO_ENCODER is capcodec", () => {
		expect(capcodecOptionsFromEnv({})).toBeNull();
		expect(
			capcodecOptionsFromEnv({ CAP_MEDIA_VIDEO_ENCODER: "x264" }),
		).toBeNull();
		expect(capcodecOptionsForJob({ crf: 18, preset: "slow" }, {})).toBeNull();
	});

	test("uses the job CRF and preset unless the environment sets them", () => {
		expect(
			capcodecOptionsForJob({ crf: 18, preset: "ultrafast" }, enabled),
		).toEqual({
			binary: "capcodec",
			crf: 18,
			preset: "fast",
			keyint: 250,
			noise: 3,
		});
		expect(
			capcodecOptionsForJob(
				{ crf: 18, preset: "slow" },
				{
					...enabled,
					CAPCODEC_BIN: "/opt/capcodec",
					CAPCODEC_CRF: "26.5",
					CAPCODEC_PRESET: "live",
					CAPCODEC_KEYINT: "120",
					CAPCODEC_NOISE: "0",
				},
			),
		).toEqual({
			binary: "/opt/capcodec",
			crf: 26.5,
			preset: "live",
			keyint: 120,
			noise: 0,
		});
	});

	test("ignores blank or out-of-range encoder settings", () => {
		expect(
			capcodecOptionsForJob(
				{ crf: 20, preset: "medium" },
				{
					...enabled,
					CAPCODEC_BIN: "  ",
					CAPCODEC_CRF: "80",
					CAPCODEC_PRESET: "",
					CAPCODEC_KEYINT: "0",
					CAPCODEC_NOISE: "-1",
				},
			),
		).toEqual({
			binary: "capcodec",
			crf: 20,
			preset: "medium",
			keyint: 250,
			noise: 3,
		});
		expect(
			capcodecOptionsFromEnv({
				...enabled,
				CAPCODEC_CRF: "nope",
				CAPCODEC_PRESET: "placebo",
			}),
		).toMatchObject({ crf: 23, preset: "slow" });
	});

	test("fits the media server's 1080p box like the libx264 scale filter", () => {
		expect(fitEvenSize(3840, 2160, 1920, 1080)).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(fitEvenSize(1280, 720, 1920, 1080)).toEqual({
			width: 1280,
			height: 720,
		});
		expect(fitEvenSize(2560, 1600, 1920, 1080)).toEqual({
			width: 1728,
			height: 1080,
		});
		expect(fitEvenSize(1001, 563, 1920, 1080)).toEqual({
			width: 1000,
			height: 562,
		});
		expect(() => fitEvenSize(0, 1080, 1920, 1080)).toThrow(
			"Video dimensions must be positive",
		);
	});

	test("expresses frame rates as exact fractions", () => {
		expect(frameRateFraction(30)).toBe("30/1");
		expect(frameRateFraction(23.976)).toBe("24000/1001");
		expect(frameRateFraction(29.97)).toBe("30000/1001");
		expect(frameRateFraction(59.94)).toBe("60000/1001");
		expect(frameRateFraction(12.5)).toBe("25/2");
		expect(frameRateFraction(Number.NaN)).toBe("30/1");
		expect(frameRateFraction(0.0001)).toBe("30/1");
	});

	test("requires a mounted capcodec binary", async () => {
		await expect(assertCapcodecBinary("/bin/true")).resolves.toBeUndefined();
		await expect(assertCapcodecBinary("/no/such/capcodec")).rejects.toThrow(
			/does not include capcodec/,
		);
	});

	test("leaves the mux the time the encode did not use", () => {
		expect(remainingTimeoutMs(10_000, 4_000)).toBe(6_000);
		expect(remainingTimeoutMs(10_000, 10_000)).toBe(1);
		expect(remainingTimeoutMs(10_000, 0)).toBe(10_000);
	});

	test("pipes raw frames from ffmpeg into capcodec", () => {
		const decode = buildCapcodecDecodeArgs(
			{ inputPath: "in.webm", extraInputArgs: [] },
			1920,
			1080,
			"30/1",
		);
		expect(decode.slice(-4)).toEqual(["yuv420p", "-progress", "pipe:2", "-"]);
		expect(decode).toContain(
			"scale=1920:1080:flags=bicubic:in_color_matrix=auto:out_color_matrix=bt709:in_range=auto:out_range=tv,format=yuv420p",
		);
		expect(decode).toContain("rawvideo");
		const encode = buildCapcodecEncodeArgs(
			{
				binary: "capcodec",
				crf: 23.5,
				preset: "medium",
				keyint: 250,
				noise: 3,
			},
			"out.mp4",
			1920,
			1080,
			"30/1",
		);
		expect(encode).toEqual([
			"capcodec",
			"encode",
			"--input",
			"-",
			"--width",
			"1920",
			"--height",
			"1080",
			"--fps",
			"30/1",
			"--crf",
			"23.5",
			"--preset",
			"medium",
			"--keyint",
			"250",
			"--noise",
			"3",
			"--output",
			"out.mp4",
		]);
	});
});
