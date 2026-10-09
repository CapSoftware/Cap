import { describe, expect, test } from "bun:test";
import {
	buildCapcodecDecodeArgs,
	buildCapcodecEncodeArgs,
	capcodecOptionsFromEnv,
	fitEvenSize,
	frameRateFraction,
} from "../../lib/capcodec-encoder";

describe("capcodec encoder integration", () => {
	test("is disabled unless CAP_MEDIA_VIDEO_ENCODER is capcodec", () => {
		expect(capcodecOptionsFromEnv({})).toBeNull();
		expect(
			capcodecOptionsFromEnv({ CAP_MEDIA_VIDEO_ENCODER: "x264" }),
		).toBeNull();
		expect(
			capcodecOptionsFromEnv({
				CAP_MEDIA_VIDEO_ENCODER: "capcodec",
				CAPCODEC_BIN: "/opt/capcodec",
				CAPCODEC_CRF: "26",
			}),
		).toEqual({
			binary: "/opt/capcodec",
			crf: 26,
			preset: "medium",
			keyint: 250,
			noise: 3,
		});
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
	});

	test("expresses frame rates as exact fractions", () => {
		expect(frameRateFraction(30)).toBe("30/1");
		expect(frameRateFraction(29.97)).toBe("30000/1001");
		expect(frameRateFraction(59.94)).toBe("60000/1001");
		expect(frameRateFraction(12.5)).toBe("25/2");
		expect(frameRateFraction(Number.NaN)).toBe("30/1");
	});

	test("pipes raw frames from ffmpeg into capcodec", () => {
		const decode = buildCapcodecDecodeArgs(
			{ inputPath: "in.webm", extraInputArgs: [] },
			1920,
			1080,
			"30/1",
		);
		expect(decode.slice(-4)).toEqual(["yuv420p", "-progress", "pipe:2", "-"]);
		expect(decode).toContain("rawvideo");
		const encode = buildCapcodecEncodeArgs(
			{ binary: "capcodec", crf: 23, preset: "medium", keyint: 250, noise: 3 },
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
			"23",
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
