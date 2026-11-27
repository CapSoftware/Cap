import { describe, expect, it } from "vitest";
import {
	DEFAULT_PLAYBACK_SPEED,
	formatPlaybackDuration,
	isPlaybackSpeed,
	normalizePlaybackSpeed,
	PLAYBACK_SPEEDS,
	resolveDefaultPlaybackSpeed,
} from "@/lib/playback-speed";

describe("playback-speed", () => {
	describe("PLAYBACK_SPEEDS constant", () => {
		it("includes 1.25x in ascending order", () => {
			expect(PLAYBACK_SPEEDS).toEqual([0.5, 0.75, 1, 1.2, 1.25, 1.5, 1.75, 2]);
		});

		it("is strictly monotonically increasing", () => {
			for (let i = 1; i < PLAYBACK_SPEEDS.length; i++) {
				const current = PLAYBACK_SPEEDS[i];
				const previous = PLAYBACK_SPEEDS[i - 1];
				if (current !== undefined && previous !== undefined) {
					expect(current).toBeGreaterThan(previous);
				}
			}
		});

		it("has 1.2 as DEFAULT_PLAYBACK_SPEED", () => {
			expect(DEFAULT_PLAYBACK_SPEED).toBe(1.2);
			expect(PLAYBACK_SPEEDS).toContain(DEFAULT_PLAYBACK_SPEED);
		});
	});

	describe("isPlaybackSpeed", () => {
		it("returns true for valid positive finite numbers", () => {
			expect(isPlaybackSpeed(1)).toBe(true);
			expect(isPlaybackSpeed(1.25)).toBe(true);
			expect(isPlaybackSpeed(0.5)).toBe(true);
		});

		it("returns false for non-positive or non-finite numbers", () => {
			expect(isPlaybackSpeed(0)).toBe(false);
			expect(isPlaybackSpeed(-1)).toBe(false);
			expect(isPlaybackSpeed(Number.NaN)).toBe(false);
			expect(isPlaybackSpeed(Number.POSITIVE_INFINITY)).toBe(false);
		});

		it("returns false for non-numeric values", () => {
			expect(isPlaybackSpeed(null)).toBe(false);
			expect(isPlaybackSpeed(undefined)).toBe(false);
			expect(isPlaybackSpeed("1.25")).toBe(false);
			expect(isPlaybackSpeed({})).toBe(false);
		});
	});

	describe("normalizePlaybackSpeed", () => {
		it("preserves exact supported speeds", () => {
			for (const speed of PLAYBACK_SPEEDS) {
				expect(normalizePlaybackSpeed(speed)).toBe(speed);
			}
		});

		it("returns DEFAULT_PLAYBACK_SPEED for invalid inputs", () => {
			expect(normalizePlaybackSpeed(null)).toBe(DEFAULT_PLAYBACK_SPEED);
			expect(normalizePlaybackSpeed(undefined)).toBe(DEFAULT_PLAYBACK_SPEED);
			expect(normalizePlaybackSpeed(0)).toBe(DEFAULT_PLAYBACK_SPEED);
			expect(normalizePlaybackSpeed(-1)).toBe(DEFAULT_PLAYBACK_SPEED);
			expect(normalizePlaybackSpeed("fast")).toBe(DEFAULT_PLAYBACK_SPEED);
		});

		it("normalizes arbitrary values to the nearest supported speed", () => {
			expect(normalizePlaybackSpeed(0.6)).toBe(0.5);
			expect(normalizePlaybackSpeed(0.7)).toBe(0.75);
			expect(normalizePlaybackSpeed(1.15)).toBe(1.2);
			expect(normalizePlaybackSpeed(1.23)).toBe(1.25);
			expect(normalizePlaybackSpeed(1.26)).toBe(1.25);
			expect(normalizePlaybackSpeed(1.3)).toBe(1.25);
			expect(normalizePlaybackSpeed(1.4)).toBe(1.5);
			expect(normalizePlaybackSpeed(1.85)).toBe(1.75);
			expect(normalizePlaybackSpeed(2.5)).toBe(2);
		});
	});

	describe("resolveDefaultPlaybackSpeed", () => {
		it("prefers valid video speed", () => {
			expect(resolveDefaultPlaybackSpeed(1.25, 1)).toBe(1.25);
			expect(resolveDefaultPlaybackSpeed(1.5, 1.25)).toBe(1.5);
		});

		it("falls back to organization speed when video speed is missing or invalid", () => {
			expect(resolveDefaultPlaybackSpeed(undefined, 1.25)).toBe(1.25);
			expect(resolveDefaultPlaybackSpeed(null, 1.25)).toBe(1.25);
			expect(resolveDefaultPlaybackSpeed(0, 1.25)).toBe(1.25);
		});

		it("falls back to DEFAULT_PLAYBACK_SPEED when neither is valid", () => {
			expect(resolveDefaultPlaybackSpeed(undefined, undefined)).toBe(
				DEFAULT_PLAYBACK_SPEED,
			);
			expect(resolveDefaultPlaybackSpeed(null, null)).toBe(
				DEFAULT_PLAYBACK_SPEED,
			);
			expect(resolveDefaultPlaybackSpeed(0, 0)).toBe(DEFAULT_PLAYBACK_SPEED);
		});
	});

	describe("formatPlaybackDuration", () => {
		it("formats non-positive or non-finite values as 0s", () => {
			expect(formatPlaybackDuration(0)).toBe("0s");
			expect(formatPlaybackDuration(-5)).toBe("0s");
			expect(formatPlaybackDuration(Number.NaN)).toBe("0s");
		});

		it("formats seconds only", () => {
			expect(formatPlaybackDuration(45)).toBe("45s");
		});

		it("formats minutes and seconds", () => {
			expect(formatPlaybackDuration(65)).toBe("1m 5s");
			expect(formatPlaybackDuration(120)).toBe("2m");
		});

		it("formats hours and minutes", () => {
			expect(formatPlaybackDuration(3600)).toBe("1h");
			expect(formatPlaybackDuration(3660)).toBe("1h 1m");
		});
	});
});
