import { describe, expect, test } from "bun:test";
import {
	audioToleranceSeconds,
	durationMismatch,
	frameSecondsForRate,
	packetSpanSeconds,
	parsePacketTimings,
} from "../../lib/hls-ladder-verify";

describe("parsePacketTimings", () => {
	test("reads pts and duration and skips lines without a time", () => {
		expect(
			parsePacketTimings("0.000000,0.033367\nN/A,N/A\n0.033367,N/A\n\n"),
		).toEqual([
			{ pts: 0, duration: 0.033367 },
			{ pts: 0.033367, duration: null },
		]);
	});
});

describe("packetSpanSeconds", () => {
	test("runs from the first pts to the end of the last packet", () => {
		expect(
			packetSpanSeconds([
				{ pts: 0.1, duration: 0.5 },
				{ pts: -0.02, duration: 0.02 },
				{ pts: 0.6, duration: 0.4 },
			]),
		).toBeCloseTo(1.02, 9);
	});

	test("gives a packet without a duration the stream's usual gap", () => {
		expect(
			packetSpanSeconds([
				{ pts: 0, duration: null },
				{ pts: 0.04, duration: null },
				{ pts: 0.08, duration: null },
			]),
		).toBeCloseTo(0.12, 9);
	});

	test("is null without packets", () => {
		expect(packetSpanSeconds([])).toBeNull();
	});
});

describe("frameSecondsForRate", () => {
	test("reads rational and decimal ladder frame rates", () => {
		expect(frameSecondsForRate("30000/1001")).toBeCloseTo(1001 / 30000, 12);
		expect(frameSecondsForRate("25")).toBeCloseTo(0.04, 12);
	});

	test("refuses a rate it cannot read", () => {
		expect(() => frameSecondsForRate("0")).toThrow();
		expect(() => frameSecondsForRate("x")).toThrow();
	});
});

describe("audioToleranceSeconds", () => {
	test("allows two AAC frames at the rendition's sample rate", () => {
		expect(audioToleranceSeconds(48_000)).toBeCloseTo(2048 / 48_000, 12);
		expect(audioToleranceSeconds(44_100)).toBeCloseTo(2048 / 44_100, 12);
		expect(() => audioToleranceSeconds(Number.NaN)).toThrow();
	});
});

describe("durationMismatch", () => {
	const frame = 1001 / 30000;

	test("accepts a rendition within one frame of the source", () => {
		expect(
			durationMismatch({
				rendition: "720p",
				track: "video",
				measuredSeconds: 6.006 - frame,
				expectedSeconds: 6.006,
				toleranceSeconds: frame,
			}),
		).toBeNull();
	});

	test("accepts the measured PCM case of exactly one AAC frame of priming", () => {
		expect(
			durationMismatch({
				rendition: "audio",
				track: "audio",
				measuredSeconds: 5.031333,
				expectedSeconds: 5.01,
				toleranceSeconds: audioToleranceSeconds(48_000),
			}),
		).toBeNull();
	});

	test("names the rendition and the measured and expected values", () => {
		expect(
			durationMismatch({
				rendition: "360p",
				track: "video",
				measuredSeconds: 5.9,
				expectedSeconds: 6.006,
				toleranceSeconds: frame,
			}),
		).toBe("360p video lasts 5.900s, expected 6.006s within 0.033s");
	});

	test("reports a rendition with no packets", () => {
		expect(
			durationMismatch({
				rendition: "audio",
				track: "audio",
				measuredSeconds: null,
				expectedSeconds: 6,
				toleranceSeconds: 0.04,
			}),
		).toBe("audio has no audio packets, expected 6.000s");
	});
});
