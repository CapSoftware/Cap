import { describe, expect, it } from "vitest";
import {
	pseudoWaveform,
	resampleWaveform,
	resolveWaveform,
	WAVEFORM_BAR_COUNT,
	WAVEFORM_MAX_PEAK,
	WAVEFORM_MIN_PEAK,
} from "../../app/s/[videoId]/_components/media-comment/WaveformBars";

describe("pseudoWaveform", () => {
	it("is deterministic for a given id", () => {
		expect(pseudoWaveform("comment-abc123")).toEqual(
			pseudoWaveform("comment-abc123"),
		);
	});

	it("differs between ids", () => {
		expect(pseudoWaveform("comment-a")).not.toEqual(
			pseudoWaveform("comment-b"),
		);
	});

	it("stays within the visible band and matches the bar count", () => {
		for (const bars of [WAVEFORM_BAR_COUNT, 40, 1]) {
			const peaks = pseudoWaveform("comment-xyz", bars);
			expect(peaks).toHaveLength(bars);
			for (const peak of peaks) {
				expect(peak).toBeGreaterThanOrEqual(WAVEFORM_MIN_PEAK);
				expect(peak).toBeLessThanOrEqual(WAVEFORM_MAX_PEAK);
			}
		}
		expect(pseudoWaveform("x", 0)).toEqual([]);
	});
});

describe("resampleWaveform", () => {
	it("keeps transients when squashing", () => {
		const peaks = new Array(128).fill(0.2);
		peaks[64] = 0.9;
		const out = resampleWaveform(peaks, 32);
		expect(out).toHaveLength(32);
		expect(Math.max(...out)).toBeCloseTo(0.9);
	});
});

describe("resolveWaveform", () => {
	it("prefers stored peaks and falls back to pseudo", () => {
		const stored = resolveWaveform("id", [0.5, 0.6], 2);
		expect(stored).toEqual([0.5, 0.6]);
		expect(resolveWaveform("id", null, 8)).toEqual(pseudoWaveform("id", 8));
		expect(resolveWaveform("id", [], 8)).toEqual(pseudoWaveform("id", 8));
	});
});
