import { describe, expect, it } from "vitest";
import { spanIndexAt, spansInOrder } from "./active-caption";

const linear = (spans: { start: number; end: number }[], time: number) =>
	spans.findIndex((span) => time >= span.start && time < span.end);

describe("active caption lookup", () => {
	const spans = [
		{ start: 0, end: 2 },
		{ start: 2, end: 3.5 },
		{ start: 5, end: 7 },
		{ start: 9, end: 9.5 },
	];

	it("recognises ordered, non-overlapping spans", () => {
		expect(spansInOrder(spans)).toBe(true);
		expect(spansInOrder([])).toBe(true);
		expect(
			spansInOrder([
				{ start: 0, end: 3 },
				{ start: 2, end: 4 },
			]),
		).toBe(false);
		expect(
			spansInOrder([
				{ start: 5, end: 6 },
				{ start: 1, end: 2 },
			]),
		).toBe(false);
	});

	it("finds the same span as a linear scan, including gaps and edges", () => {
		for (let time = -1; time <= 11; time += 0.25) {
			expect(spanIndexAt(spans, time, true)).toBe(linear(spans, time));
		}
		expect(spanIndexAt(spans, 2, true)).toBe(1);
		expect(spanIndexAt(spans, 3.5, true)).toBe(-1);
	});

	it("scans spans that overlap or are out of order", () => {
		const overlapping = [
			{ start: 0, end: 5 },
			{ start: 2, end: 3 },
		];
		expect(spanIndexAt(overlapping, 2.5, false)).toBe(0);
	});

	it("handles no captions", () => {
		expect(spanIndexAt([], 1, true)).toBe(-1);
		expect(spanIndexAt([], 1, false)).toBe(-1);
	});
});
