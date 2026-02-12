import { describe, expect, it } from "vitest";
import {
	findNextSegmentIndex,
	findSegmentIndexAtTime,
} from "@/app/editor/utils/playback";

describe("findSegmentIndexAtTime", () => {
	it("finds index for time inside a segment", () => {
		const segments = [
			{ start: 0, end: 5, timescale: 1 },
			{ start: 10, end: 15, timescale: 1 },
			{ start: 20, end: 25, timescale: 1 },
		];

		expect(findSegmentIndexAtTime(segments, 12)).toBe(1);
	});

	it("resolves exact boundaries to the next segment", () => {
		const segments = [
			{ start: 0, end: 5, timescale: 1 },
			{ start: 5, end: 10, timescale: 1 },
		];

		expect(findSegmentIndexAtTime(segments, 5)).toBe(1);
	});
});

describe("findNextSegmentIndex", () => {
	it("returns next segment when time is in a gap", () => {
		const segments = [
			{ start: 0, end: 5, timescale: 1 },
			{ start: 10, end: 15, timescale: 1 },
		];

		expect(findNextSegmentIndex(segments, 6)).toBe(1);
	});

	it("returns current segment index when time equals a segment start", () => {
		const segments = [
			{ start: 0, end: 5, timescale: 1 },
			{ start: 10, end: 15, timescale: 1 },
		];

		expect(findNextSegmentIndex(segments, 10)).toBe(1);
	});

	it("returns -1 when no next segment exists", () => {
		const segments = [{ start: 0, end: 5, timescale: 1 }];

		expect(findNextSegmentIndex(segments, 10)).toBe(-1);
	});
});
