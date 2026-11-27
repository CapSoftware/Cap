import { describe, expect, test } from "vitest";
import {
	playheadMotion,
	playheadMotionOffsetMs,
	playheadMotionX,
} from "./playhead-motion";

describe("playheadMotion", () => {
	test("moves in device pixels at the playback rate", () => {
		const motion = playheadMotion(100, 200, 0.5, 2);
		expect(motion).toEqual({
			from: 100,
			to: 200,
			steps: 200,
			durationMs: 50_000,
		});
		if (!motion) return;
		expect(playheadMotionX(motion, 0, 2)).toBe(100);
		expect(playheadMotionX(motion, 249, 2)).toBe(100);
		expect(playheadMotionX(motion, 250, 2)).toBe(100.5);
		expect(playheadMotionX(motion, 25_000, 2)).toBe(150);
		expect(playheadMotionX(motion, 99_999, 2)).toBe(200);
	});

	test("stops on the last whole device pixel before the limit", () => {
		expect(playheadMotion(10, 10.9, 1, 1)).toBeNull();
		expect(playheadMotion(10, 12.7, 1, 1)?.to).toBe(12);
	});

	test("does nothing for an unusable scale", () => {
		expect(playheadMotion(0, 100, 0, 2)).toBeNull();
		expect(playheadMotion(Number.NaN, 100, 1, 2)).toBeNull();
	});
});

test("playheadMotionOffsetMs steps where rounding would", () => {
	const motion = playheadMotion(100, 200, 0.5, 2);
	if (!motion) throw new Error("no motion");
	// true x 100.2 rounds to 100 until it reaches 100.25 (0.05 px, 25 ms away)
	const offset = playheadMotionOffsetMs(motion, 100.2, 2);
	expect(offset).toBeCloseTo(225);
	expect(playheadMotionX(motion, offset + 24, 2)).toBe(100);
	expect(playheadMotionX(motion, offset + 26, 2)).toBe(100.5);
	expect(playheadMotionOffsetMs(motion, 99.75, 2)).toBe(0);
});
