import { describe, expect, it } from "vitest";
import {
	envelopeFromVtt,
	parseVttCues,
	pseudoEnvelope,
	WAVEFORM_BUCKETS,
	WAVEFORM_FLOOR,
} from "@/app/s/[videoId]/_components/timeline/waveform-envelope";

const VTT = `WEBVTT

1
00:00:00.000 --> 00:00:10.000
Talking at the start.

2
00:01:30.000 --> 00:01:40.000
And again near the end.
`;

const DURATION = 100;
const BUCKETS = 100;

const bucketAt = (envelope: Float32Array, seconds: number) =>
	envelope[Math.floor((seconds / DURATION) * envelope.length)] ?? 0;

describe("parseVttCues", () => {
	it("reads start and end times, milliseconds included", () => {
		expect(parseVttCues(VTT)).toEqual([
			{ start: 0, end: 10 },
			{ start: 90, end: 100 },
		]);
	});

	it("accepts MM:SS.mmm cues", () => {
		expect(parseVttCues("WEBVTT\n\n00:01.500 --> 00:02.250\nhi\n")).toEqual([
			{ start: 1.5, end: 2.25 },
		]);
	});

	it("returns nothing for empty or garbage input", () => {
		expect(parseVttCues("")).toEqual([]);
		expect(parseVttCues("WEBVTT\n\nnot a cue at all\n")).toEqual([]);
		expect(parseVttCues("00:00:05.000 --> 00:00:01.000\nbackwards\n")).toEqual(
			[],
		);
	});
});

describe("envelopeFromVtt", () => {
	it("lands speech in the buckets the cues cover", () => {
		const envelope = envelopeFromVtt(VTT, DURATION, BUCKETS);

		expect(bucketAt(envelope, 5)).toBeGreaterThan(0.5);
		expect(bucketAt(envelope, 95)).toBeGreaterThan(0.5);
		// The silent middle stays near the floor.
		expect(bucketAt(envelope, 50)).toBeLessThan(0.2);
	});

	it("normalises to 0-1 and never drops below the floor", () => {
		const envelope = envelopeFromVtt(VTT, DURATION, BUCKETS);

		expect(envelope).toHaveLength(BUCKETS);
		for (const value of envelope) {
			expect(value).toBeGreaterThanOrEqual(WAVEFORM_FLOOR - 1e-6);
			expect(value).toBeLessThanOrEqual(1 + 1e-6);
		}
		expect(Math.max(...envelope)).toBeCloseTo(1, 5);
	});

	it("is deterministic", () => {
		expect(Array.from(envelopeFromVtt(VTT, DURATION, BUCKETS))).toEqual(
			Array.from(envelopeFromVtt(VTT, DURATION, BUCKETS)),
		);
	});

	it("draws a flat floor when there is nothing to read", () => {
		for (const input of ["", "WEBVTT\n\n", "}{ nonsense"]) {
			const envelope = envelopeFromVtt(input, DURATION, BUCKETS);
			expect(envelope).toHaveLength(BUCKETS);
			for (const value of envelope)
				expect(value).toBeCloseTo(WAVEFORM_FLOOR, 5);
		}
	});

	it("gives up gracefully on a nonsense duration or bucket count", () => {
		expect(envelopeFromVtt(VTT, 0, BUCKETS)).toHaveLength(BUCKETS);
		expect(envelopeFromVtt(VTT, DURATION, 0)).toHaveLength(0);
		expect(envelopeFromVtt(VTT, DURATION, Number.NaN)).toHaveLength(0);
	});
});

describe("pseudoEnvelope", () => {
	it("is deterministic per seed", () => {
		expect(Array.from(pseudoEnvelope("video-a", DURATION, BUCKETS))).toEqual(
			Array.from(pseudoEnvelope("video-a", DURATION, BUCKETS)),
		);
		expect(
			Array.from(pseudoEnvelope("video-a", DURATION, BUCKETS)),
		).not.toEqual(Array.from(pseudoEnvelope("video-b", DURATION, BUCKETS)));
	});

	it("stays inside the floor and the ceiling", () => {
		const envelope = pseudoEnvelope("video-a", DURATION, BUCKETS);
		expect(envelope).toHaveLength(BUCKETS);
		for (const value of envelope) {
			expect(value).toBeGreaterThanOrEqual(WAVEFORM_FLOOR - 1e-6);
			expect(value).toBeLessThanOrEqual(1 + 1e-6);
		}
		expect(Math.max(...envelope)).toBeCloseTo(1, 5);
	});

	it("varies across the strip rather than drawing a bar", () => {
		const envelope = pseudoEnvelope("video-a", DURATION, BUCKETS);
		const unique = new Set(Array.from(envelope));
		expect(unique.size).toBeGreaterThan(BUCKETS / 2);
	});

	it("costs the same at any duration", () => {
		expect(pseudoEnvelope("video-a", 30)).toHaveLength(WAVEFORM_BUCKETS);
		expect(pseudoEnvelope("video-a", 3 * 3600)).toHaveLength(WAVEFORM_BUCKETS);
	});
});
