import { describe, expect, it } from "vitest";
import {
	FILMSTRIP_MAX_TILES,
	filmstripPoolQuantum,
	filmstripWindowTimes,
	nearestPooledTime,
	POOL_QUANTUM_MAX,
	POOL_QUANTUM_MIN,
	poolBorrowTolerance,
	quantizePoolTime,
	rememberFrame,
} from "@/app/s/[videoId]/_components/timeline/filmstrip-math";

describe("filmstripPoolQuantum", () => {
	it("scales with the duration between its bounds", () => {
		expect(filmstripPoolQuantum(1120)).toBeCloseTo(10);
		expect(filmstripPoolQuantum(10)).toBe(POOL_QUANTUM_MIN);
		expect(filmstripPoolQuantum(12 * 3600)).toBe(POOL_QUANTUM_MAX);
	});

	it("is safe before the duration is known", () => {
		expect(filmstripPoolQuantum(0)).toBe(POOL_QUANTUM_MIN);
		expect(filmstripPoolQuantum(Number.NaN)).toBe(POOL_QUANTUM_MIN);
	});
});

describe("quantizePoolTime", () => {
	it("snaps a moment onto the grid", () => {
		expect(quantizePoolTime(7.4, 2)).toBe(8);
		expect(quantizePoolTime(6.9, 2)).toBe(6);
		expect(quantizePoolTime(-5, 2)).toBe(0);
	});

	it("collapses nearby requests onto one slot", () => {
		expect(quantizePoolTime(10.1, 5)).toBe(quantizePoolTime(11.9, 5));
	});
});

describe("filmstripWindowTimes", () => {
	it("puts one time at the centre of every tile in the window", () => {
		expect(filmstripWindowTimes(4, 0, 100, 100)).toEqual([
			12.5, 37.5, 62.5, 87.5,
		]);
	});

	it("follows the window rather than the video", () => {
		expect(filmstripWindowTimes(2, 40, 60, 100)).toEqual([45, 55]);
	});

	it("keeps clear of the very last frames", () => {
		const times = filmstripWindowTimes(2, 0, 10, 10);
		expect(times[1]).toBeCloseTo(7.5);
		expect(filmstripWindowTimes(1, 9.9, 10, 10)[0]).toBeCloseTo(9.9);
	});

	it("returns nothing without a window, tiles or a duration", () => {
		expect(filmstripWindowTimes(0, 0, 100, 100)).toEqual([]);
		expect(filmstripWindowTimes(4, 50, 50, 100)).toEqual([]);
		expect(filmstripWindowTimes(4, 0, 100, 0)).toEqual([]);
	});
});

describe("nearestPooledTime", () => {
	it("borrows the closest frame inside the tolerance", () => {
		expect(nearestPooledTime([0, 5, 10], 6, 2)).toBe(5);
		expect(nearestPooledTime([0, 5, 10], 9, 2)).toBe(10);
	});

	it("refuses anything further away than the tolerance", () => {
		// Dead centre between two frames, both of them out of reach.
		expect(nearestPooledTime([0, 5, 10], 7.5, 2)).toBeNull();
		expect(nearestPooledTime([0, 20], 10, 2)).toBeNull();
		expect(nearestPooledTime([], 10, 100)).toBeNull();
	});
});

describe("poolBorrowTolerance", () => {
	it("never reaches closer than the grid it captures onto", () => {
		expect(poolBorrowTolerance(2, 10, 28)).toBe(2);
	});

	it("widens to a tile when zoomed out past the grid", () => {
		expect(poolBorrowTolerance(0.5, 280, 28)).toBe(10);
	});
});

describe("rememberFrame", () => {
	it("drops the oldest capture once the pool is full", () => {
		const frames = new Map<number, string>();
		for (let index = 0; index < 5; index += 1) {
			rememberFrame(frames, index, `frame-${index}`, 3);
		}

		expect(frames.size).toBe(3);
		expect(Array.from(frames.keys())).toEqual([2, 3, 4]);
	});

	it("overwrites a slot in place rather than growing", () => {
		const frames = new Map<number, string>();
		rememberFrame(frames, 1, "a", 2);
		rememberFrame(frames, 1, "b", 2);

		expect(frames.size).toBe(1);
		expect(frames.get(1)).toBe("b");
	});

	it("keeps enough frames for a full strip at any zoom", () => {
		const frames = new Map<number, string>();
		for (let index = 0; index < FILMSTRIP_MAX_TILES; index += 1) {
			rememberFrame(frames, index, `frame-${index}`);
		}
		expect(frames.size).toBe(FILMSTRIP_MAX_TILES);
	});
});
