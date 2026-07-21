import { describe, expect, it } from "vitest";
import {
	calculatePlaybackDurationMs,
	calculateRemainingPlaybackDurationMs,
	clamp,
	countWords,
	formatRecordingDuration,
} from "./teleprompter";

describe("mobile teleprompter", () => {
	it("counts pasted scripts consistently", () => {
		expect(countWords("  One   two\nthree ")).toBe(3);
		expect(countWords(" ")).toBe(0);
	});

	it("derives playback duration from reading speed", () => {
		expect(calculatePlaybackDurationMs("one two three", 180)).toBe(1000);
		expect(calculatePlaybackDurationMs("one two three", 60)).toBe(3000);
		expect(calculatePlaybackDurationMs("", 150)).toBe(0);
	});

	it("keeps resumed playback proportional to the unread script", () => {
		expect(calculateRemainingPlaybackDurationMs(10_000, 0.25)).toBe(7500);
		expect(calculateRemainingPlaybackDurationMs(10_000, 2)).toBe(0);
	});

	it("clamps teleprompter settings", () => {
		expect(clamp(5, 10, 20)).toBe(10);
		expect(clamp(25, 10, 20)).toBe(20);
	});

	it("formats a native recording timer", () => {
		expect(formatRecordingDuration(0)).toBe("0:00");
		expect(formatRecordingDuration(65.9)).toBe("1:05");
		expect(formatRecordingDuration(3661)).toBe("1:01:01");
	});
});
