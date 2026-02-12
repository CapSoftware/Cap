import { describe, expect, it } from "vitest";
import {
	displayToSourceTime,
	sourceToDisplayTime,
} from "@/app/editor/utils/time";
import {
	splitSegmentAtSourceTime,
	trimSegmentEnd,
	trimSegmentStart,
} from "@/app/editor/utils/timeline";

describe("splitSegmentAtSourceTime", () => {
	it("splits a segment using source time", () => {
		const segments = [{ start: 10, end: 20, timescale: 1 }];
		const result = splitSegmentAtSourceTime(segments, 15);

		expect(result).not.toBeNull();
		expect(result?.selectionIndex).toBe(1);
		expect(result?.segments).toEqual([
			{ start: 10, end: 15, timescale: 1 },
			{ start: 15, end: 20, timescale: 1 },
		]);
	});

	it("returns null when splitting at boundaries", () => {
		const segments = [{ start: 10, end: 20, timescale: 1 }];

		expect(splitSegmentAtSourceTime(segments, 10)).toBeNull();
		expect(splitSegmentAtSourceTime(segments, 20)).toBeNull();
		expect(splitSegmentAtSourceTime(segments, 5)).toBeNull();
	});
});

describe("trimSegmentStart", () => {
	it("prevents overlapping the previous segment", () => {
		const segments = [
			{ start: 0, end: 5, timescale: 1 },
			{ start: 5, end: 12, timescale: 1 },
		];

		const result = trimSegmentStart(segments, 1, 2);

		expect(result).toEqual([
			{ start: 0, end: 5, timescale: 1 },
			{ start: 5, end: 12, timescale: 1 },
		]);
	});
});

describe("trimSegmentEnd", () => {
	it("prevents overlapping the next segment", () => {
		const segments = [
			{ start: 0, end: 5, timescale: 1 },
			{ start: 5, end: 12, timescale: 1 },
		];

		const result = trimSegmentEnd(segments, 0, 8, 20);

		expect(result).toEqual([
			{ start: 0, end: 5, timescale: 1 },
			{ start: 5, end: 12, timescale: 1 },
		]);
	});

	it("clamps the last segment end to video duration", () => {
		const segments = [{ start: 2, end: 6, timescale: 1 }];
		const result = trimSegmentEnd(segments, 0, 20, 10);

		expect(result).toEqual([{ start: 2, end: 10, timescale: 1 }]);
	});
});

describe("display timeline mapping", () => {
	it("compresses source gaps into contiguous display time", () => {
		const segments = [
			{ start: 0, end: 5, timescale: 1 },
			{ start: 10, end: 15, timescale: 1 },
			{ start: 20, end: 25, timescale: 1 },
		];

		expect(sourceToDisplayTime(20, segments)).toBe(10);
		expect(displayToSourceTime(7.5, segments)).toBe(12.5);
	});
});
