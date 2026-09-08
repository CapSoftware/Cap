import { describe, expect, it } from "vitest";

import { splitZoomSegmentAt } from "./zoom-segments";

type Segment = {
	start: number;
	end: number;
	amount: number;
};

function segment(start: number, end: number, amount = 1.5): Segment {
	return { start, end, amount };
}

describe("splitZoomSegmentAt", () => {
	it("splits into left [start, start+time] and right [start+time, end]", () => {
		const segments = [segment(10, 30)];
		const result = splitZoomSegmentAt(segments, 0, 8);

		expect(result).not.toBeNull();
		expect(segments[0]).toMatchObject({ start: 10, end: 18 });
		expect(segments[1]).toMatchObject({ start: 18, end: 30 });
		expect(result?.newSegmentIndex).toBe(1);
	});

	it("preserves the segment's other properties on both halves", () => {
		const segments = [segment(0, 10, 2.5)];
		splitZoomSegmentAt(segments, 0, 4);

		expect(segments[0].amount).toBe(2.5);
		expect(segments[1].amount).toBe(2.5);
	});

	it("keeps the new (right) piece selectable after a re-sort around existing segments", () => {
		const segments = [segment(0, 10), segment(20, 30), segment(40, 50)];
		const result = splitZoomSegmentAt(segments, 1, 5);

		expect(segments.map((s) => s.start)).toEqual([0, 20, 25, 40]);
		expect(segments.map((s) => s.end)).toEqual([10, 25, 30, 50]);
		expect(result?.newSegmentIndex).toBe(2);
		expect(segments[result?.newSegmentIndex ?? -1]).toMatchObject({
			start: 25,
			end: 30,
		});
	});

	it("rejects splits that would leave a piece shorter than one second", () => {
		const segments = [segment(10, 30)];

		expect(splitZoomSegmentAt(segments, 0, 0.5)).toBeNull();
		expect(splitZoomSegmentAt(segments, 0, 20.5)).toBeNull();
		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({ start: 10, end: 30 });
	});

	it("returns null for an out-of-bounds index without mutating the array", () => {
		const segments = [segment(0, 10)];

		expect(splitZoomSegmentAt(segments, 3, 5)).toBeNull();
		expect(segments).toHaveLength(1);
	});
});
