import { describe, expect, it } from "vitest";
import {
	fractionInWindow,
	RAIL_PAD_X,
	timeFromClientX,
} from "@/app/s/[videoId]/_components/timeline/timeline-constants";
import {
	clampWindow,
	followWindow,
	fullWindow,
	isFullWindow,
	MIN_WINDOW_S,
	panWindowBy,
	zoomWindowAt,
} from "@/app/s/[videoId]/_components/timeline/timeline-window";

const DURATION = 100;
/** 1000px of usable rail, so one second of a full window is ten pixels. */
const RECT = { left: 0, width: 1000 + RAIL_PAD_X * 2 };

describe("fractionInWindow", () => {
	it("maps a moment onto its place in the window", () => {
		expect(fractionInWindow(50, 0, 100)).toBeCloseTo(0.5);
		expect(fractionInWindow(45, 40, 60)).toBeCloseTo(0.25);
	});

	it("runs outside 0-1 off-window, so callers can cull", () => {
		expect(fractionInWindow(30, 40, 60)).toBeLessThan(0);
		expect(fractionInWindow(70, 40, 60)).toBeGreaterThan(1);
	});

	it("is zero for a window with no span", () => {
		expect(fractionInWindow(10, 5, 5)).toBe(0);
		expect(fractionInWindow(10, 0, Number.NaN)).toBe(0);
	});
});

describe("timeFromClientX", () => {
	it("reads a time out of the padded rail", () => {
		expect(timeFromClientX(RAIL_PAD_X, RECT, 0, DURATION)).toBeCloseTo(0);
		expect(timeFromClientX(RAIL_PAD_X + 500, RECT, 0, DURATION)).toBeCloseTo(
			50,
		);
	});

	it("reads it out of the window, not the video", () => {
		expect(timeFromClientX(RAIL_PAD_X + 500, RECT, 40, 60)).toBeCloseTo(50);
		expect(timeFromClientX(RAIL_PAD_X, RECT, 40, 60)).toBeCloseTo(40);
		expect(timeFromClientX(RAIL_PAD_X + 1000, RECT, 40, 60)).toBeCloseTo(60);
	});

	it("clamps to the rail and gives up on an unmeasured band", () => {
		expect(timeFromClientX(-500, RECT, 40, 60)).toBeCloseTo(40);
		expect(timeFromClientX(9999, RECT, 40, 60)).toBeCloseTo(60);
		expect(timeFromClientX(100, { left: 0, width: 0 }, 0, DURATION)).toBe(0);
	});
});

describe("clampWindow", () => {
	it("keeps the window inside the video", () => {
		expect(clampWindow({ start: -20, end: 30 }, DURATION)).toEqual({
			start: 0,
			end: 50,
		});
		expect(clampWindow({ start: 80, end: 130 }, DURATION)).toEqual({
			start: 50,
			end: 100,
		});
	});

	it("refuses to collapse below the minimum span", () => {
		const tight = clampWindow({ start: 50, end: 51 }, DURATION);
		expect(tight.end - tight.start).toBeCloseTo(MIN_WINDOW_S);
	});

	it("falls back to the whole video when it is shorter than the minimum", () => {
		const short = clampWindow({ start: 1, end: 2 }, 4);
		expect(short).toEqual({ start: 0, end: 4 });
	});

	it("has nothing to clamp before the duration is known", () => {
		expect(clampWindow({ start: 0, end: 10 }, 0)).toEqual({ start: 0, end: 0 });
	});
});

describe("zoomWindowAt", () => {
	it("keeps the focus time under the cursor", () => {
		const focus = 30;
		let window = fullWindow(DURATION);
		const anchor = fractionInWindow(focus, window.start, window.end);

		for (const factor of [1.5, 1.5, 2, 1.25]) {
			window = zoomWindowAt(window, factor, focus, DURATION);
			expect(fractionInWindow(focus, window.start, window.end)).toBeCloseTo(
				anchor,
				5,
			);
		}
	});

	it("shrinks the span on the way in and grows it on the way out", () => {
		const zoomed = zoomWindowAt(fullWindow(DURATION), 2, 50, DURATION);
		expect(zoomed.end - zoomed.start).toBeCloseTo(50);

		const back = zoomWindowAt(zoomed, 0.5, 50, DURATION);
		expect(back.end - back.start).toBeCloseTo(100);
		expect(isFullWindow(back, DURATION)).toBe(true);
	});

	it("stops at the minimum span and at the video edges", () => {
		const tiny = zoomWindowAt(fullWindow(DURATION), 1000, 0, DURATION);
		expect(tiny.end - tiny.start).toBeCloseTo(MIN_WINDOW_S);
		expect(tiny.start).toBeCloseTo(0);

		const atEnd = zoomWindowAt(fullWindow(DURATION), 1000, DURATION, DURATION);
		expect(atEnd.end).toBeCloseTo(DURATION);
	});

	it("ignores a nonsense factor", () => {
		const window = { start: 20, end: 40 };
		expect(zoomWindowAt(window, 0, 30, DURATION)).toEqual(window);
		expect(zoomWindowAt(window, Number.NaN, 30, DURATION)).toEqual(window);
	});
});

describe("panWindowBy", () => {
	it("slides the window without changing its span", () => {
		const panned = panWindowBy({ start: 20, end: 40 }, 15, DURATION);
		expect(panned).toEqual({ start: 35, end: 55 });
	});

	it("stops at the ends", () => {
		expect(panWindowBy({ start: 20, end: 40 }, -100, DURATION)).toEqual({
			start: 0,
			end: 20,
		});
		expect(panWindowBy({ start: 20, end: 40 }, 100, DURATION)).toEqual({
			start: 80,
			end: 100,
		});
	});
});

describe("followWindow", () => {
	it("does nothing while the playhead is on screen", () => {
		expect(followWindow({ start: 20, end: 40 }, 30, DURATION)).toBeNull();
	});

	it("does nothing when the whole video is on screen", () => {
		expect(followWindow(fullWindow(DURATION), 30, DURATION)).toBeNull();
	});

	it("puts the playhead a fifth of the way in once it has left", () => {
		const next = followWindow({ start: 20, end: 40 }, 41, DURATION);
		expect(next).not.toBeNull();
		if (!next) return;
		expect(next.end - next.start).toBeCloseTo(20);
		expect(fractionInWindow(41, next.start, next.end)).toBeCloseTo(0.2);
	});

	it("gives up rather than jitter when the window is already at the end", () => {
		expect(followWindow({ start: 80, end: 100 }, 101, DURATION)).toBeNull();
	});
});
