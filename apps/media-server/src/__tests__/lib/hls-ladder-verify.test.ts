import { describe, expect, test } from "bun:test";
import {
	audioToleranceSeconds,
	durationMismatch,
	frameSecondsForRate,
	PacketSpan,
} from "../../lib/hls-ladder-verify";

function spanOf(lines: string[]): number | null {
	const span = new PacketSpan();
	for (const line of lines) span.addLine(line);
	return span.seconds();
}

describe("PacketSpan", () => {
	test("runs from the first pts to the end of the last packet", () => {
		expect(spanOf(["0.1,0.5", "-0.02,0.02", "0.6,0.4"])).toBeCloseTo(1.02, 9);
	});

	test("skips lines without a time", () => {
		expect(spanOf(["N/A,N/A", "", "0,0.5", "0.5,0.5"])).toBeCloseTo(1, 9);
	});

	test("skips packets flagged for discard", () => {
		expect(
			spanOf([
				"-1.500000,0.033333,KD_",
				"-1.466667,0.033333,_D_",
				"0.000000,0.033333,___",
				"0.033333,0.033333,___",
				"-0.023220,0.023220,KD_,",
			]),
		).toBeCloseTo(0.066666, 6);
	});

	test("gives a packet without a duration the usual gap at the stream's end", () => {
		expect(spanOf(["0,N/A", "0.04,N/A", "0.08,N/A"])).toBeCloseTo(0.12, 9);
		expect(spanOf(["0.08,N/A", "0,0.04", "0.04,0.04"])).toBeCloseTo(0.12, 9);
	});

	test("measures a long stream from the packets as they arrive", () => {
		const span = new PacketSpan();
		const frame = 1 / 60;
		for (let index = 0; index < 864_000; index++) {
			span.add(index * frame, index % 2 === 0 ? frame : null);
		}
		expect(span.seconds()).toBeCloseTo(864_000 * frame, 6);
	});

	test("is null without packets", () => {
		expect(new PacketSpan().seconds()).toBeNull();
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
