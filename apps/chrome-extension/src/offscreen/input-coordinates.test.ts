import { describe, expect, it } from "vitest";
import { mapTabPointerToVideo } from "./input-coordinates";

describe("tab input coordinates", () => {
	it("places viewport corners inside Chrome tab-capture padding", () => {
		const topLeft = mapTabPointerToVideo(0, 0, 1273, 716, 3024, 1964);
		const center = mapTabPointerToVideo(0.5, 0.5, 1273, 716, 3024, 1964);
		const bottomRight = mapTabPointerToVideo(1, 1, 1273, 716, 3024, 1964);
		expect(topLeft?.x).toBe(0);
		expect(topLeft?.y).toBeCloseTo(131 / 1964, 2);
		expect(center).toEqual({ x: 0.5, y: 0.5 });
		expect(bottomRight?.x).toBe(1);
		expect(bottomRight?.y).toBeCloseTo(1832 / 1964, 2);
	});

	it("maps portrait tabs with side padding", () => {
		const pointer = mapTabPointerToVideo(0, 0, 716, 1273, 1920, 1080);
		expect(pointer?.x).toBeGreaterThan(0);
		expect(pointer?.y).toBe(0);
	});

	it("rejects impossible source dimensions", () => {
		expect(mapTabPointerToVideo(0.5, 0.5, 0, 100, 1920, 1080)).toBeNull();
		expect(
			mapTabPointerToVideo(Number.NaN, 0.5, 100, 100, 1920, 1080),
		).toBeNull();
	});
});
